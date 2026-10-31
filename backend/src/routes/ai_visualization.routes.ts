import {
  Router,
  Request,
  Response,
} from 'express';

import { prisma } from '@db/connection';
import { logActivity } from '@services/activityLog.service';

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

          scene_image_path:
            typeof scene_image_path ===
            'string'
              ? scene_image_path.trim()
              : undefined,

          scene_image_url:
            typeof scene_image_url ===
            'string'
              ? scene_image_url.trim()
              : undefined,

          scene_image_mode:
            typeof scene_image_mode ===
            'string'
              ? scene_image_mode.trim()
              : undefined,

          generate_random_scene:
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
      await recordGeneration(req, result, resolvedMaterials);

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
};

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

/** One stored row as the history page reads it. */
/** A tile the history resolved from a stored product code. */
export type KnownTile = {
  name?: string | null;
  productCode?: string | null;
  imageUrl?: string | null;
  size?: string | null;
  finish?: string | null;
};

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
  // The log kept one product CODE and nothing else, so the card showed
  // a bare "DME-ITACA-1200X2400-COLLECTION-1-0023" and no picture -- of
  // a board whose highlight tile is plainly visible in the render.
  //
  // The code is still a real catalog product, so it is resolved to its
  // Tile row here and shown with its own image and name like any other.
  // What CANNOT be recovered is the rest of the combination: this flow
  // never wrote a mood board to the database, so there is nowhere the
  // highlight and accent survive. The card says that in as many words
  // rather than implying the room was built from one tile.
  const products = stored.length ? stored : recoveredBase(String(meta.productName ?? ''), tilesByCode);

  return {
    id: row.id,
    createdAt: row.createdAt,
    by: row.user?.name ?? '',
    imageUrl: String(meta.imageUrl ?? ''),
    imageSource: String(meta.imageSource ?? ''),
    productName: String(meta.productName ?? ''),
    room: String(meta.room ?? ''),
    style: String(meta.style ?? ''),
    combinationName: String(meta.combinationName ?? ''),
    // False when the combination was never recorded, so the page can say
    // the list is partial instead of presenting it as the whole board.
    productsRecorded: stored.length > 0,
    products: products
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        role: String(entry.role ?? ''),
        name: String(entry.name ?? ''),
        code: String(entry.code ?? ''),
        size: String(entry.size ?? ''),
        finish: String(entry.finish ?? ''),
        imageUrl: String(entry.imageUrl ?? ''),
      })),
  };
}

/** The base tile of an old row, as one product entry, or none. */
function recoveredBase(
  code: string,
  tilesByCode: ReadonlyMap<string, KnownTile>,
): Array<Record<string, string>> {
  const trimmed = code.trim();
  if (!trimmed) return [];
  const tile = tilesByCode.get(trimmed);
  if (!tile) return [{ role: 'base', name: '', code: trimmed, size: '', finish: '', imageUrl: '' }];
  return [{
    role: 'base',
    name: String(tile.name ?? ''),
    code: String(tile.productCode ?? trimmed),
    size: String(tile.size ?? ''),
    finish: String(tile.finish ?? ''),
    imageUrl: String(tile.imageUrl ?? ''),
  }];
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
    },
    req,
  });
}

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

    // THE OLD ROWS' BASE TILE, RESOLVED ONCE.
    //
    // Rows written before the combination was recorded carry a product
    // code and nothing else. One query turns every such code on this
    // page into a real tile, so those cards show a picture and a name
    // instead of a bare code. Rows that recorded their products need
    // nothing and are not looked up.
    const codes = [...new Set(
      page
        .filter((row) => !Array.isArray((row.metadata as Record<string, unknown> | null)?.products))
        .map((row) => String((row.metadata as Record<string, unknown> | null)?.productName ?? '').trim())
        .filter(Boolean),
    )];

    const tilesByCode = new Map<string, KnownTile>();
    if (codes.length) {
      const tiles = await prisma.tile.findMany({
        where: { productCode: { in: codes } },
        select: { name: true, productCode: true, imageUrl: true, size: true, finish: true },
      });
      tiles.forEach((tile) => {
        if (tile.productCode) tilesByCode.set(tile.productCode, tile);
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