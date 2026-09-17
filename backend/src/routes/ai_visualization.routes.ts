import {
  Router,
  Request,
  Response,
} from 'express';

import { prisma } from '@db/connection';

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
          select: { productCode: true, name: true, imageUrl: true },
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

          requirements:
            requirements &&
            typeof requirements ===
              'object'
              ? requirements
              : {},

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

export default router;