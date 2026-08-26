import {
  Router,
  Request,
  Response,
} from 'express';

import { prisma } from '@db/connection';

import {
  generateVisualization,
} from '../services/python-ai.service';

const router = Router();

// ============================================================
// POST /visualizations
// ============================================================

router.post(
  '/visualizations',
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
          select: { productCode: true, name: true },
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