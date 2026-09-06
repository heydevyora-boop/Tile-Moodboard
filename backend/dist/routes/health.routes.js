"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const connection_1 = require("@db/connection");
const catchAsync_1 = require("@utils/catchAsync");
const index_1 = require("@config/index");
const router = (0, express_1.Router)();
router.get('/', (0, catchAsync_1.catchAsync)(async (_req, res) => {
    let dbStatus = 'up';
    try {
        await connection_1.prisma.$queryRaw `SELECT 1`;
    }
    catch {
        dbStatus = 'down';
    }
    const body = {
        success: true,
        app: index_1.config.app.name,
        env: index_1.config.env,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        db: dbStatus,
    };
    res.status(dbStatus === 'up' ? 200 : 503).json(body);
}));
exports.default = router;
//# sourceMappingURL=health.routes.js.map