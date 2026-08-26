import {
  Router,
  Request,
  Response,
} from 'express';

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

      if (
        typeof scene_image_path !== 'string' ||
        !scene_image_path.trim()
      ) {
        return res.status(400).json({
          success: false,

          error: {
            type:
              'VALIDATION_ERROR',

            message:
              'scene_image_path is required.',
          },
        });
      }

      // ========================================================
      // NODE → PYTHON
      // ========================================================

      const result =
        await generateVisualization({
          product_id:
            product_id.trim(),

          surface:
            surface
              .trim()
              .toUpperCase(),

          scene_image_path:
            scene_image_path.trim(),

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