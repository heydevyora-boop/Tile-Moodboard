"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecommendations = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const connection_1 = require("@db/connection");
const tileRecommendation_service_1 = require("@services/tileRecommendation.service");
exports.getRecommendations = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const tiles = await (0, tileRecommendation_service_1.getRecommendedTiles)(connection_1.prisma, query);
    res.status(200).json({ success: true, data: { tiles } });
});
//# sourceMappingURL=tileRecommendation.controller.js.map