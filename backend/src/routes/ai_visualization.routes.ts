import {
  Router,
  Request,
  Response,
} from 'express';

import { prisma } from '@db/connection';
import { logActivity } from '@services/activityLog.service';
import { normalizeDriveImageUrl } from '@services/referenceImages.service';
import { isStarterId, starterById, STARTER_PATH } from '@services/libraryStarters';
import { config } from '@config/index';

import { authenticate, requirePermission } from '@middlewares/auth';

import {
  generateVisualization,
} from '../services/python-ai.service';

const router = Router();

// This endpoint proxies straight through to the paid Gemini generation
// pipeline in catalog_processor -- it must not be open to the internet.
// It never writes to a Tile row (the one DB call below is a read), so it
// gets its own visualizations:write permission rather than tiles:write,
// which also gates real tile mutations in catalogExtractor.routes.ts.
router.use(authenticate);

// ============================================================
// POST /visualizations
// ============================================================

router.post(
  '/visualizations',
  requirePermission('visualizations:write'),
  async (
    req: Request,
    res: Response,
  ) => {
    try {
      const {
        product_id,
        surface,
        scene_image_path,
        scene_image_url,
        scene_image_mode,
        generate_random_scene,
        spreadsheet_id,
        sheet_name,
        scene_id,
        theme,
        requirements,
        materials,
        library_reference_id,
      } = req.body;

      // ========================================================
      // VALIDATION
      // ========================================================

      if (
        typeof product_id !== 'string' ||
        !product_id.trim()
      ) {
        return res.status(400).json({
          success: false,

          error: {
            type:
              'VALIDATION_ERROR',

            message:
              'product_id is required.',
          },
        });
      }

      if (
        typeof surface !== 'string' ||
        !surface.trim()
      ) {
        return res.status(400).json({
          success: false,

          error: {
            type:
              'VALIDATION_ERROR',

            message:
              'surface is required.',
          },
        });
      }

      // scene_image_path is intentionally optional: an empty value
      // (or scene_image_mode "random" / generate_random_scene)
      // tells Python to generate a bathroom scene instead of
      // fetching one. Requiring it non-empty here would reject
      // that request with a 400 before it ever reaches Python.

      // ========================================================
      // RESOLVE THE MASTER-SHEET PRODUCT CODE
      // ========================================================
      // The frontend only ever knows the tile's Postgres id (the
      // cuid Gemini's combination output uses as tileId) — the
      // Python side's MASTER sheet is keyed by the catalog's own
      // Product ID/Record ID, which lives on Tile.productCode.
      // Sending the raw Postgres id straight through, as before,
      // can never match a MASTER row.

      const tile =
        await prisma.tile.findUnique({
          where: { id: product_id.trim() },
          select: { productCode: true, name: true, imageUrl: true, size: true, finish: true },
        });

      if (!tile) {
        return res.status(404).json({
          success: false,

          error: {
            type: 'NOT_FOUND',

            message:
              `Tile ${product_id.trim()} was not found.`,
          },
        });
      }

      if (!tile.productCode) {
        return res.status(422).json({
          success: false,

          error: {
            type: 'VALIDATION_ERROR',

            message:
              `Tile "${tile.name}" has no catalog product code set, ` +
              `so it can't be matched in the MASTER sheet for AI visualization.`,
          },
        });
      }

      // ========================================================
      // RESOLVE THE REST OF THE COMBINATION
      // ========================================================
      // A mood board is a base tile PLUS the highlight and accent
      // picked to sit with it, and visualizing it is the whole point of
      // choosing three. Only product_id was ever sent, so the generated
      // bathroom could only ever show one material and the other two
      // selections had no effect on the image.
      //
      // Each entry is resolved the same way the base is, just above:
      // Postgres id -> MASTER product code + that tile's own extracted
      // catalog image. Resolving them HERE rather than trusting the
      // browser is what makes requirement "use the actual latest
      // selected image" true -- the image sent is whatever Tile.imageUrl
      // holds right now, not whatever the page was rendered with.

      const requestedMaterials =
        Array.isArray(materials)
          ? materials
              .filter(
                (entry: unknown): entry is Record<string, unknown> =>
                  Boolean(entry) && typeof entry === 'object',
              )
              .map((entry) => ({
                role: String(entry.role ?? '').trim().toLowerCase(),
                tileId: String(
                  entry.tile_id ?? entry.tileId ?? entry.product_id ?? '',
                ).trim(),
              }))
              .filter((entry) => entry.tileId)
          : [];

      const resolvedMaterials: Array<{
        role: string;
        image_url: string;
        product_id?: string;
        name?: string;
        size?: string;
        finish?: string;
      }> = [];

      if (requestedMaterials.length > 0) {
        const materialTiles =
          await prisma.tile.findMany({
            where: {
              id: {
                in: requestedMaterials.map((entry) => entry.tileId),
              },
            },
            select: {
              id: true,
              name: true,
              imageUrl: true,
              productCode: true,
              size: true,
              finish: true,
            },
          });

        const tilesById = new Map(
          materialTiles.map((row) => [row.id, row]),
        );

        for (const entry of requestedMaterials) {
          const row = tilesById.get(entry.tileId);

          // A material with no resolvable image cannot be drawn, so it
          // is skipped -- but only it. Failing the whole request would
          // lose the materials that ARE renderable, and silently
          // dropping it without a line in the log is how this class of
          // bug stayed invisible in the first place.
          if (!row?.imageUrl) {
            console.warn(
              `Visualization: ${entry.role || 'material'} tile ` +
                `${entry.tileId} has no image, so it cannot be ` +
                `included in the generated scene.`,
            );
            continue;
          }

          resolvedMaterials.push({
            role: entry.role,
            image_url: row.imageUrl,
            product_id: row.productCode ?? undefined,
            name: row.name ?? undefined,
            size: row.size ?? undefined,
            finish: row.finish ?? undefined,
          });
        }
      }

      // ========================================================
      // THE CLIENT'S CHOSEN DE'VYORA LIBRARY ROOM
      // ========================================================
      // When a reference was chosen, THAT PHOTOGRAPH IS THE SCENE. It
      // goes to Python as the scene image, so Stage 2 applies the
      // materials onto the client's own picture and its composition,
      // camera, light and perspective survive by construction rather
      // than by instruction. Stage 1 -- the step that invents a room --
      // does not run at all, because the room already exists.
      //
      // THE ROW IS THE AUTHORITY, NOT THE BROWSER. Only the reference's
      // id is accepted; the URL that is fetched and the words that
      // describe it are read from the database here, exactly as each
      // tile's image is resolved above rather than trusted from the
      // page. A browser that could name its own scene URL could point
      // this server's fetcher anywhere.
      //
      // A reference that has been deleted or unpublished since the
      // client chose it FAILS, and says so. Quietly generating an
      // invented room instead would hand them a picture that is not of
      // the room they asked for, with nothing on it to say so.

      let libraryScene: { id: string; title: string; imageUrl: string; room: string | null } | null = null;

      if (typeof library_reference_id === 'string' && library_reference_id.trim()) {
        const wanted = library_reference_id.trim();

        // A STARTER ROOM IS A FILE THIS SERVER ITSELF SERVES.
        //
        // Python fetches the scene over the public internet from its own
        // function, so a relative path is no use to it -- the URL has to
        // be absolute and reachable. The configured public URL is
        // preferred; failing that the origin is taken from this request,
        // which on a Vercel deployment is the real deployment host and
        // needs no environment variable set.
        //
        // Only the ORIGIN comes from the header. The path is fixed here,
        // so a forged Host cannot point the fetcher at a file of the
        // caller's choosing -- it can only make the fetch fail.
        if (isStarterId(wanted)) {
          const starter = starterById(wanted);

          if (!starter) {
            return res.status(404).json({
              success: false,
              error: {
                type: 'NOT_FOUND',
                message:
                  'That starter room is not one this version of De\u2019vyora ships. '
                  + 'Choose a reference again from the Library.',
              },
            });
          }

          // THE REQUEST'S OWN ORIGIN FIRST, not the configured one.
          //
          // On Vercel every deployment has its own hostname, so a
          // BACKEND_PUBLIC_URL set once is stale by the next deploy --
          // and a stale one here does not degrade, it hands Python an
          // address it cannot reach. The incoming request always knows
          // the host it actually arrived on, in every environment
          // including a developer's laptop. The configured value is
          // kept only for the case where there is no Host header at all.
          const host = req.get('host');
          const origin = host
            ? `${req.protocol}://${host}`
            : (config.backend.publicUrl || '').replace(/\/+$/, '');

          libraryScene = {
            id: starter.id,
            title: starter.title,
            imageUrl: `${origin}${STARTER_PATH}/${starter.file}`,
            room: starter.room,
          };
        }

        const row = libraryScene
          ? null
          : await prisma.libraryReference.findFirst({
            where: { id: wanted, isActive: true },
            select: { id: true, title: true, imageUrl: true, room: true },
          });

        if (!libraryScene && !row) {
          return res.status(404).json({
            success: false,

            error: {
              type: 'NOT_FOUND',

              message:
                'That reference room is no longer in the De\u2019vyora Library, '
                + 'so the image cannot be built on it. Choose a reference again '
                + 'from the Library.',
            },
          });
        }

        if (row) libraryScene = row;
      }

      // How the reference is named to the generator. Built from the row,
      // and only the row.
      const referenceRoomText =
        libraryScene
          ? `"${libraryScene.title}"${libraryScene.room ? ` (${libraryScene.room})` : ''}`
          : '';

      // ========================================================
      // NODE → PYTHON
      // ========================================================

      const result =
        await generateVisualization({
          product_id:
            tile.productCode,

          surface:
            surface
              .trim()
              .toUpperCase(),

          // The library reference wins over whatever the page sent:
          // it is the only one of these this server has verified.
          scene_image_path:
            libraryScene
              ? undefined
              : typeof scene_image_path ===
                'string'
                ? scene_image_path.trim()
                : undefined,

          scene_image_url:
            libraryScene
              ? libraryScene.imageUrl
              : typeof scene_image_url ===
                'string'
                ? scene_image_url.trim()
                : undefined,

          scene_image_mode:
            libraryScene
              ? 'reference'
              : typeof scene_image_mode ===
                'string'
                ? scene_image_mode.trim()
                : undefined,

          // Never, with a reference: a generated room would replace the
          // one the client chose.
          generate_random_scene:
            !libraryScene &&
            generate_random_scene ===
            true,

          spreadsheet_id:
            typeof spreadsheet_id ===
            'string'
              ? spreadsheet_id.trim()
              : undefined,

          sheet_name:
            typeof sheet_name ===
            'string'
              ? sheet_name.trim()
              : undefined,

          scene_id:
            typeof scene_id ===
            'string'
              ? scene_id.trim()
              : undefined,

          theme:
            typeof theme ===
            'string'
              ? theme.trim()
              : undefined,

          // The base tile's catalog size and finish ride along from the
          // DB, not the browser, so a single-tile prompt can state the
          // real product -- a combination carries them per material.
          requirements: {
            ...(requirements &&
            typeof requirements ===
              'object'
              ? requirements
              : {}),
            ...(tile.size ? { tile_size: tile.size } : {}),
            ...(tile.finish ? { tile_finish: tile.finish } : {}),
            // tile_application_engine.build_tile_application_prompt
            // reads this and, only when it is set, tells the model that
            // IMAGE 1 is the client's own chosen photograph and
            // outranks the theme. `requirements` is already threaded
            // end to end, which is why this needs no new parameter on
            // any of the five layers in between.
            ...(referenceRoomText
              ? { reference_room: referenceRoomText }
              : {}),
          },

          // The tile's own extracted catalog image, sent as a safety
          // net so Python can fall back to it when the MASTER sheet
          // has no product row (or no resolvable image) for this
          // product code, instead of fabricating a placeholder swatch.
          fallback_image_url:
            tile.imageUrl ??
            undefined,

          // Empty for a single-tile request, which leaves Python on its
          // existing one-image path.
          materials:
            resolvedMaterials.length > 0
              ? resolvedMaterials
              : undefined,
        });

      // ========================================================
      // PYTHON FAILED
      // ========================================================

      if (
        result.success === false
      ) {
        return res.status(503).json({
          success: false,

          error:
            result.error || {
              type:
                'PYTHON_AI_ERROR',

              message:
                'Python visualization failed.',
            },
        });
      }

      // ========================================================
      // SUCCESS
      // ========================================================

      // ========================================================
      // RECORD IT, SO IT CAN BE FOUND AGAIN
      // ========================================================
      // Until now a generated scene existed only in the browser tab
      // that asked for it: the page holds it in memory, a reload or a
      // regeneration loses it, and nothing anywhere kept a copy. There
      // is no table for visualizations and no migration runs on this
      // deployment, so the record goes in activity_logs -- the one
      // place that already exists, already has a Json column and is
      // already written to from a dozen other places.
      //
      // WHICH URL IS KEPT. A Drive link is durable and tiny, so it
      // wins. Failing that, the data: URL Python embedded is the only
      // copy that survives at all -- Node and Python have no shared
      // disk here, so /generated-visualizations/<file> names a file in
      // another container that will be gone by the next request. A
      // data URL is megabytes, so one that is implausibly large is
      // recorded without its image rather than bloating the table.
      await recordGeneration(req, result, resolvedMaterials, libraryScene);

      return res.status(200).json({
        success: true,

        data: result,
      });
    } catch (error) {
      console.error(
        'AI visualization error:',
        error,
      );

      return res.status(502).json({
        success: false,

        error: {
          type:
            'AI_SERVICE_ERROR',

          message:
            error instanceof Error
              ? error.message
              : 'AI visualization service failed.',
        },
      });
    }
  },
);

// ============================================================
// RECENT GENERATIONS
// ============================================================

const GENERATION_ACTION = 'visualization.generated';

// A data: URL beyond this is not worth a database row. Measured
// against what Python returns: a 1024px PNG lands around 1.5-2.5 MB
// base64, so this leaves real headroom without letting one row grow
// without limit.
const MAX_STORED_IMAGE_CHARS = 6 * 1024 * 1024;

type VisualizationResult = {
  visualization_id?: string;
  image?: { url?: string; data_url?: string };
  drive?: { image?: { url?: string; webContentLink?: string; webViewLink?: string } };
  visualization?: { product_name?: string; surface?: string };
  theme_check?: unknown;
};

// ─────────────────────────────────────────────────────────────────────────
// THE VERDICT, KEPT WITH THE GENERATION
//
// Every scene is already judged against its theme, and the mood board
// shows the finding -- once. Nothing kept it: recordGeneration wrote the
// picture, the products and the room, and dropped the verdict, so the
// history could say a scene existed and not whether it came back as the
// theme that was asked for. A board whose floor was reported as missing
// its heritage pattern looks, a week later, exactly like one that passed.
//
// Only what a person can act on is kept: the status, what it judged, and
// the lines that were partial or missing. The "present" list is the
// reassuring half and is not worth a database row.
//
// Bounded on purpose. This goes into a Json column that already carries
// a generated image, so it is capped rather than trusted.
// ─────────────────────────────────────────────────────────────────────────

const VERDICT_LINES = 8;
const VERDICT_LINE_CHARS = 300;

export function generationVerdict(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;

  const status = String(v.status ?? '').trim().toLowerCase();
  if (!status) return null;

  const lines = (value: unknown): string[] => (
    Array.isArray(value)
      ? value
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().slice(0, VERDICT_LINE_CHARS))
        .filter(Boolean)
        .slice(0, VERDICT_LINES)
      : []
  );

  return {
    status,
    theme: String(v.theme ?? '').slice(0, 120),
    room: String(v.room ?? '').slice(0, 60),
    reason: String(v.reason ?? '').slice(0, VERDICT_LINE_CHARS),
    partial: lines(v.partial),
    missing: lines(v.missing),
  };
}

function durableImageUrl(result: VisualizationResult): { url: string; source: string } {
  const drive = result.drive?.image;
  const driveUrl = drive?.url || drive?.webContentLink || drive?.webViewLink;
  if (driveUrl) return { url: driveUrl, source: 'drive' };

  const inline = result.image?.data_url
    || (result.image?.url?.startsWith('data:') ? result.image.url : '');
  if (inline && inline.length <= MAX_STORED_IMAGE_CHARS) {
    return { url: inline, source: 'inline' };
  }
  if (inline) return { url: '', source: 'too-large' };

  // A /generated-visualizations/<file> path is deliberately NOT kept:
  // it points into Python's own container and 404s from here.
  return { url: '', source: 'not-kept' };
}

// THE PRODUCTS THE SCENE WAS BUILT FROM.
//
// The log kept one `productName` -- the base -- so the history could
// say a scene existed but not which tiles made it. The route has
// already resolved every material to a real Tile row by the time it
// records anything (name, product code, that tile's own extracted
// image, size, finish), so the whole combination is kept, in the order
// it was sent: base first, then highlight and accent.
//
// A tile's image is normally a URL. If it ever arrives as an inline
// data: URL it is dropped rather than written -- four of those in one
// row would be megabytes of history per generation, and the card falls
// back to the name, which is the part that matters.
export const GENERATION_PRODUCT_LIMIT = 8;
const MAX_STORED_PRODUCT_URL_CHARS = 2048;

export function generationProducts(
  materials: ReadonlyArray<{
    role?: string;
    image_url?: string;
    product_id?: string;
    name?: string;
    size?: string;
    finish?: string;
  }>,
): Array<Record<string, string>> {
  return materials.slice(0, GENERATION_PRODUCT_LIMIT).map((entry) => {
    const imageUrl = String(entry.image_url ?? '');
    return {
      role: String(entry.role ?? ''),
      name: String(entry.name ?? ''),
      code: String(entry.product_id ?? ''),
      size: String(entry.size ?? ''),
      finish: String(entry.finish ?? ''),
      imageUrl:
        imageUrl.startsWith('data:') || imageUrl.length > MAX_STORED_PRODUCT_URL_CHARS
          ? ''
          : imageUrl,
    };
  });
}

/** A tile the history resolved from a stored product code. */
export type KnownTile = {
  imageUrl?: string | null;
  name?: string | null;
  size?: string | null;
  finish?: string | null;
};

/**
 * One stored row as the history page reads it.
 *
 * `tilesByCode` fills in a picture the log does not hold. A product's
 * image is dropped at write time when it is an inline data: URL or an
 * absurdly long one -- four of those would be megabytes of history per
 * generation -- so the row keeps the product CODE and no picture, and
 * the card showed a grey placeholder beside a name.
 *
 * The code names a real catalog product, so the image is read back from
 * the Tile row at display time instead. That also keeps it CURRENT: a
 * re-extracted product shows its new picture rather than the one it had
 * on the day the board was generated.
 */
export function generationRow(
  row: {
    id: string;
    createdAt: Date | string;
    metadata?: unknown;
    user?: { name?: string | null } | null;
  },
  tilesByCode: ReadonlyMap<string, KnownTile> = new Map(),
): Record<string, unknown> {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const stored = Array.isArray(meta.products) ? meta.products : [];

  // A GENERATION FROM BEFORE THE COMBINATION WAS RECORDED.
  //
  // Those rows kept one product CODE -- the base -- and nothing else,
  // so the card printed the bare code in a sentence and showed no
  // product and no picture at all.
  //
  // The code names a real catalog product, so it is turned into an
  // ordinary product entry here and shown with its own image and name
  // like any other. What CANNOT be recovered is the rest of the
  // combination: this flow never wrote a mood board to the database
  // (moodBoards.generate is stateless by design), so there is no
  // MoodBoardTile row anywhere holding the highlight and the accent.
  // They are gone, and `productsPartial` lets the card say so rather
  // than presenting one tile as the whole board.
  const legacyCode = String(meta.productName ?? '').trim();
  const partial = stored.length === 0 && Boolean(legacyCode);
  const products = partial
    ? [{ role: 'base', name: '', code: legacyCode, size: '', finish: '', imageUrl: '' }]
    : stored;

  // THE SCENE'S BYTES ARE NOT PUT IN THE LIST.
  //
  // A generated scene is kept as an inline data: URL -- the only copy
  // that survives, since Node and Python share no disk -- and one of
  // them is 1.5-2.5MB of base64. The history asked for sixty rows at a
  // time and inlined every one of those into the JSON and then into the
  // page's HTML, so opening Recent Generations downloaded on the order
  // of a hundred megabytes before it drew anything. That is the whole
  // of the wait the catalog owner reported.
  //
  // The row carries a PATH to the picture instead. The card fetches it
  // when it scrolls into view, so the page paints at once and only the
  // scenes actually looked at are ever transferred.
  //
  // A Drive link is a URL and tiny, so it is still sent as one.
  const storedImage = String(meta.imageUrl ?? '');
  const inlineImage = storedImage.startsWith('data:');

  return {
    id: row.id,
    createdAt: row.createdAt,
    by: row.user?.name ?? '',
    imageUrl: inlineImage ? '' : storedImage,
    /** Where to fetch the scene when it is wanted; empty for a plain URL. */
    imagePath: inlineImage ? `/ai/visualizations/recent/${row.id}/image` : '',
    /** Whether there is a picture at all, however it is reached. */
    hasImage: Boolean(storedImage),
    imageSource: String(meta.imageSource ?? ''),
    // Null for everything generated before the verdict was kept, which
    // the card reads as "not recorded" rather than as a pass.
    themeCheck: generationVerdict(meta.themeCheck),
    productName: String(meta.productName ?? ''),
    room: String(meta.room ?? ''),
    style: String(meta.style ?? ''),
    combinationName: String(meta.combinationName ?? ''),
    /**
     * The De'vyora Library room this scene was built on. Empty for a
     * scene generated from the theme alone, which is every scene made
     * before the library existed -- so the card shows the line only
     * when there is one, rather than printing "no reference".
     */
    libraryReference: String(meta.libraryReferenceTitle ?? ''),
    libraryReferenceId: String(meta.libraryReferenceId ?? ''),
    // True when only the base survives, so the card does not present one
    // tile as if it were the whole combination.
    productsPartial: partial,
    products: products
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => {
        const code = String(entry.code ?? '');
        const storedUrl = String(entry.imageUrl ?? '');
        // THE DRIVE LINK A BROWSER CAN ACTUALLY RENDER.
        //
        // Tile.imageUrl carries Drive's webViewLink -- an HTML viewer
        // PAGE. An <img> pointed at it is handed a document instead of
        // pixels and shows a broken-image icon, which is exactly what
        // this card was showing beside every product name.
        //
        // The mood board's own tile lookup has always normalised these
        // (moodBoard.service.ts, getTilesByIds). This did not. Done at
        // READ time so the history already written is fixed too, not
        // only what is generated from now on.
        const tile = tilesByCode.get(code);
        return {
          role: String(entry.role ?? ''),
          name: String(entry.name ?? '') || String(tile?.name ?? ''),
          code,
          size: String(entry.size ?? '') || String(tile?.size ?? ''),
          finish: String(entry.finish ?? '') || String(tile?.finish ?? ''),
          imageUrl: String(
            normalizeDriveImageUrl(storedUrl || String(tile?.imageUrl ?? '')) ?? '',
          ),
        };
      }),
  };
}

async function recordGeneration(
  req: Request,
  result: VisualizationResult,
  materials: ReadonlyArray<{
    role?: string;
    image_url?: string;
    product_id?: string;
    name?: string;
    size?: string;
    finish?: string;
  }> = [],
  // The De'vyora Library room this scene was built on, when there was
  // one. Kept so the history can say WHICH reference produced a picture
  // -- without it, a reference-built scene and an invented one are
  // indistinguishable in the record, and "is this really based on the
  // room I chose?" has no answer.
  libraryScene: { id: string; title: string } | null = null,
): Promise<void> {
  const { url, source } = durableImageUrl(result);
  const body = req.body as Record<string, unknown>;
  const requirements = (body.requirements ?? {}) as Record<string, unknown>;

  await logActivity({
    userId: req.user?.id,
    action: GENERATION_ACTION,
    entityType: 'Visualization',
    entityId: result.visualization_id,
    metadata: {
      imageUrl: url,
      imageSource: source,
      productName: result.visualization?.product_name ?? '',
      surface: result.visualization?.surface ?? '',
      room: String(requirements.room ?? ''),
      style: String(requirements.style ?? ''),
      combinationName: String(requirements.combination_name ?? ''),
      products: generationProducts(materials),
      themeCheck: generationVerdict(result.theme_check),
      ...(libraryScene
        ? {
          libraryReferenceId: libraryScene.id,
          libraryReferenceTitle: libraryScene.title,
        }
        : {}),
    },
    req,
  });
}

// ============================================================
// GET /visualizations/recent/:id/image
// ============================================================
//
// One stored scene, as bytes.
//
// The list above sends a path here rather than the picture itself, so
// this is where a card's scene actually comes from. It reads the one row
// it is asked for, decodes the data: URL the generation recorded and
// answers with the image, which is what the browser wanted in the first
// place -- a data: URL inside JSON inside HTML is the same bytes carried
// three times over.
//
// A generation's record never changes, so it is immutable for a year.
// Private, because a studio's generated work is not public.
// ============================================================

/** The pieces of `data:<mime>;base64,<payload>`, or null if it is not one. */
export function decodeDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value.trim());
  if (!match) return null;
  const mime = match[1].trim();
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length > 0 ? { mime, bytes } : null;
}

router.get(
  '/visualizations/recent/:id/image',
  requirePermission('visualizations:write'),
  async (req: Request, res: Response) => {
    const row = await prisma.activityLog.findFirst({
      where: { id: String(req.params.id ?? ''), action: GENERATION_ACTION },
      select: { metadata: true },
    });

    const stored = String(
      ((row?.metadata ?? {}) as Record<string, unknown>).imageUrl ?? '',
    );

    // A row whose picture is a plain URL is not served from here: the
    // card has that URL already and loads it directly.
    const decoded = stored.startsWith('data:') ? decodeDataUrl(stored) : null;
    if (!decoded) {
      return res.status(404).json({
        success: false,
        error: { type: 'NOT_FOUND', message: 'No stored image for this generation.' },
      });
    }

    res.setHeader('Content-Type', decoded.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.status(200).end(decoded.bytes);
  },
);

// ============================================================
// GET /visualizations/recent
// ============================================================

router.get(
  '/visualizations/recent',
  requirePermission('visualizations:write'),
  async (req: Request, res: Response) => {
    // EVERY generation, not the newest 30.
    //
    // This took the first 30 rows and stopped, with nothing to ask for
    // the rest, so a studio with more history than that simply could
    // not see it -- and nothing on the page said so. It is paged now
    // rather than unbounded: the page walks `nextCursor` until it comes
    // back null, and `total` lets it say how many it is showing.
    //
    // Ordered by id as well as createdAt. Two rows written in the same
    // millisecond are otherwise in an arbitrary order, and a cursor into
    // an arbitrary order can repeat a row or skip one.
    const asked = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 100) : 60;
    const cursor = String(req.query.cursor ?? '').trim();

    const where = { action: GENERATION_ACTION };
    const [total, rows] = await Promise.all([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, createdAt: true, metadata: true, user: { select: { name: true } } },
      }),
    ]);

    const page = rows.slice(0, limit);

    // THE PICTURES THE LOG DOES NOT HOLD, READ BACK ONCE.
    //
    // A product whose image was an inline data: URL was recorded
    // without one, so its card showed a name and a grey square -- and a
    // history nobody can recognise a product in is not much of a
    // history. One query turns every such code on this page into its
    // tile, and products that recorded their own picture need nothing.
    const codes = [...new Set(
      page.flatMap((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const products = Array.isArray(meta.products) ? meta.products : [];
        if (!products.length) {
          // Pre-products rows keep the base code under productName.
          return [String(meta.productName ?? '').trim()].filter(Boolean);
        }
        return products
          .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
          .filter((e) => !String(e.imageUrl ?? '').trim())
          .map((e) => String(e.code ?? '').trim())
          .filter(Boolean);
      }),
    )];

    const tilesByCode = new Map<string, KnownTile>();
    if (codes.length) {
      const tiles = await prisma.tile.findMany({
        where: { productCode: { in: codes } },
        select: { productCode: true, imageUrl: true, name: true, size: true, finish: true },
      });
      tiles.forEach((tile) => {
        if (tile.productCode) {
          tilesByCode.set(tile.productCode, {
            imageUrl: tile.imageUrl,
            name: tile.name,
            size: tile.size,
            finish: tile.finish,
          });
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        total,
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        generations: page.map((row) => generationRow(row, tilesByCode)),
      },
    });
  },
);

export default router;