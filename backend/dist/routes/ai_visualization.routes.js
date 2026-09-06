"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("@db/connection");
const python_ai_service_1 = require("../services/python-ai.service");
const router = (0, express_1.Router)();
router.post('/visualizations', async (req, res) => {
    try {
        const { product_id, surface, scene_image_path, scene_image_url, scene_image_mode, generate_random_scene, spreadsheet_id, sheet_name, scene_id, theme, requirements, } = req.body;
        if (typeof product_id !== 'string' ||
            !product_id.trim()) {
            return res.status(400).json({
                success: false,
                error: {
                    type: 'VALIDATION_ERROR',
                    message: 'product_id is required.',
                },
            });
        }
        if (typeof surface !== 'string' ||
            !surface.trim()) {
            return res.status(400).json({
                success: false,
                error: {
                    type: 'VALIDATION_ERROR',
                    message: 'surface is required.',
                },
            });
        }
        const tile = await connection_1.prisma.tile.findUnique({
            where: { id: product_id.trim() },
            select: { productCode: true, name: true, imageUrl: true },
        });
        if (!tile) {
            return res.status(404).json({
                success: false,
                error: {
                    type: 'NOT_FOUND',
                    message: `Tile ${product_id.trim()} was not found.`,
                },
            });
        }
        if (!tile.productCode) {
            return res.status(422).json({
                success: false,
                error: {
                    type: 'VALIDATION_ERROR',
                    message: `Tile "${tile.name}" has no catalog product code set, ` +
                        `so it can't be matched in the MASTER sheet for AI visualization.`,
                },
            });
        }
        const result = await (0, python_ai_service_1.generateVisualization)({
            product_id: tile.productCode,
            surface: surface
                .trim()
                .toUpperCase(),
            scene_image_path: typeof scene_image_path ===
                'string'
                ? scene_image_path.trim()
                : undefined,
            scene_image_url: typeof scene_image_url ===
                'string'
                ? scene_image_url.trim()
                : undefined,
            scene_image_mode: typeof scene_image_mode ===
                'string'
                ? scene_image_mode.trim()
                : undefined,
            generate_random_scene: generate_random_scene ===
                true,
            spreadsheet_id: typeof spreadsheet_id ===
                'string'
                ? spreadsheet_id.trim()
                : undefined,
            sheet_name: typeof sheet_name ===
                'string'
                ? sheet_name.trim()
                : undefined,
            scene_id: typeof scene_id ===
                'string'
                ? scene_id.trim()
                : undefined,
            theme: typeof theme ===
                'string'
                ? theme.trim()
                : undefined,
            requirements: requirements &&
                typeof requirements ===
                    'object'
                ? requirements
                : {},
            fallback_image_url: tile.imageUrl ??
                undefined,
        });
        if (result.success === false) {
            return res.status(503).json({
                success: false,
                error: result.error || {
                    type: 'PYTHON_AI_ERROR',
                    message: 'Python visualization failed.',
                },
            });
        }
        return res.status(200).json({
            success: true,
            data: result,
        });
    }
    catch (error) {
        console.error('AI visualization error:', error);
        return res.status(502).json({
            success: false,
            error: {
                type: 'AI_SERVICE_ERROR',
                message: error instanceof Error
                    ? error.message
                    : 'AI visualization service failed.',
            },
        });
    }
});
exports.default = router;
//# sourceMappingURL=ai_visualization.routes.js.map