"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncMasterTile = exports.deleteExtractedTile = exports.updateExtractedTile = exports.deleteCatalog = exports.retryExtraction = exports.getCatalogTiles = exports.getCatalog = exports.listCatalogs = exports.uploadCatalog = exports.listBrands = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const AppError_1 = require("@utils/AppError");
const catalogExtractorService = __importStar(require("@services/catalogExtractor.service"));
const brandService = __importStar(require("@services/brand.service"));
const masterTileSyncService = __importStar(require("@services/masterTileSync.service"));
function requireActorId(req) {
    if (!req.user)
        throw AppError_1.AppError.unauthorized('Authentication required');
    return req.user.id;
}
exports.listBrands = (0, catchAsync_1.catchAsync)(async (_req, res) => {
    const brands = await brandService.listBrands();
    res.status(200).json({ success: true, data: { brands } });
});
exports.uploadCatalog = (0, catchAsync_1.catchAsync)(async (req, res) => {
    if (!req.file)
        throw AppError_1.AppError.badRequest('No file uploaded — attach a PDF under field name "file"');
    const input = req.body;
    const catalog = await catalogExtractorService.uploadAndCreateCatalog(req.file, input, requireActorId(req), req);
    res.status(202).json({ success: true, data: { catalog }, message: 'Upload received — extraction started in the background' });
});
exports.listCatalogs = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { catalogs, meta } = await catalogExtractorService.listCatalogs(query);
    res.status(200).json({ success: true, data: { catalogs }, meta });
});
exports.getCatalog = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const catalog = await catalogExtractorService.getCatalogById(req.params.id);
    res.status(200).json({ success: true, data: { catalog } });
});
exports.getCatalogTiles = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const query = req.query;
    const { tiles, meta } = await catalogExtractorService.getCatalogTiles(req.params.id, query);
    res.status(200).json({ success: true, data: { tiles }, meta });
});
exports.retryExtraction = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const catalog = await catalogExtractorService.retryExtraction(req.params.id, requireActorId(req), req);
    res.status(202).json({ success: true, data: { catalog }, message: 'Retry started' });
});
exports.deleteCatalog = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const deleteTiles = req.query.deleteTiles === 'true';
    await catalogExtractorService.deleteCatalog(req.params.id, deleteTiles, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Catalog deleted' });
});
exports.updateExtractedTile = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const tile = await catalogExtractorService.updateExtractedTile(req.params.tileId, input, requireActorId(req), req);
    res.status(200).json({ success: true, data: { tile } });
});
exports.deleteExtractedTile = (0, catchAsync_1.catchAsync)(async (req, res) => {
    await catalogExtractorService.deleteExtractedTile(req.params.tileId, requireActorId(req), req);
    res.status(200).json({ success: true, message: 'Tile deleted' });
});
exports.syncMasterTile = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const input = req.body;
    const { tile, created } = await masterTileSyncService.syncMasterTile(input, req);
    res.status(created ? 201 : 200).json({
        success: true,
        data: { tile: { id: tile.id, productCode: tile.productCode, name: tile.name, brandId: tile.brandId, imageUrl: tile.imageUrl } },
        message: created ? 'Tile created from MASTER' : 'Tile updated from MASTER',
    });
});
//# sourceMappingURL=catalogExtractor.controller.js.map