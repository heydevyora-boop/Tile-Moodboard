"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncMasterTile = syncMasterTile;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const brand_service_1 = require("./brand.service");
const activityLog_service_1 = require("./activityLog.service");
async function syncMasterTile(input, req) {
    const brand = await (0, brand_service_1.resolveBrand)({ brandName: input.brandName });
    if (!brand)
        throw AppError_1.AppError.badRequest('Could not resolve a brand for this product');
    const name = input.productName?.trim() || input.productCode;
    const existing = await connection_1.prisma.tile.findFirst({ where: { productCode: input.productCode } });
    const data = {
        name,
        brandId: brand.id,
        size: input.size ?? undefined,
        finish: input.finish ?? undefined,
        type: (input.type ?? 'BASE'),
        colorTone: input.colorTone ?? undefined,
        bestRoom: input.bestRoom ?? undefined,
        collection: input.collection ?? undefined,
        imageUrl: input.imageUrl ?? undefined,
        sheetRowRef: input.sheetRowRef ?? 0,
    };
    const tile = existing
        ? await connection_1.prisma.tile.update({ where: { id: existing.id }, data })
        : await connection_1.prisma.tile.create({ data: { ...data, productCode: input.productCode } });
    await (0, activityLog_service_1.logActivity)({
        action: existing ? 'tile.master_synced.updated' : 'tile.master_synced.created',
        entityType: 'Tile',
        entityId: tile.id,
        metadata: { productCode: input.productCode, brandName: input.brandName, source: 'MASTER_SHEET' },
        req,
    });
    return { tile, created: !existing };
}
//# sourceMappingURL=masterTileSync.service.js.map