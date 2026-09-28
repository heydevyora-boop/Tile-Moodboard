"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExtractionQueueStats = getExtractionQueueStats;
exports.parseProgressLine = parseProgressLine;
exports.uploadAndCreateCatalog = uploadAndCreateCatalog;
exports.runExtraction = runExtraction;
exports.retryExtraction = retryExtraction;
exports.listCatalogs = listCatalogs;
exports.getCatalogById = getCatalogById;
exports.getCatalogTiles = getCatalogTiles;
exports.deleteCatalog = deleteCatalog;
exports.updateExtractedTile = updateExtractedTile;
exports.deleteExtractedTile = deleteExtractedTile;
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
const logger_1 = require("@utils/logger");
const pythonRunner_1 = require("@utils/pythonRunner");
const fileSignature_1 = require("@utils/fileSignature");
const pagination_1 = require("@utils/pagination");
const activityLog_service_1 = require("./activityLog.service");
const brand_service_1 = require("./brand.service");
const extractionQueue_service_1 = require("./extractionQueue.service");
function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto_1.default.createHash('sha256');
        const stream = fs_1.default.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
const extractionQueue = (0, extractionQueue_service_1.getExtractionQueue)(index_1.config.catalog.extractionConcurrency, runExtraction);
async function getExtractionQueueStats() {
    const [pending, processing, completed, failed] = await Promise.all([
        connection_1.prisma.catalog.count({ where: { status: 'PENDING' } }),
        connection_1.prisma.catalog.count({ where: { status: 'PROCESSING' } }),
        connection_1.prisma.catalog.count({ where: { status: 'COMPLETED' } }),
        connection_1.prisma.catalog.count({ where: { status: 'FAILED' } }),
    ]);
    return {
        queueDepth: extractionQueue.queueDepth,
        runningCount: extractionQueue.runningCount,
        counts: { PENDING: pending, PROCESSING: processing, COMPLETED: completed, FAILED: failed },
    };
}
const VALID_TILE_TYPES = new Set(['BASE', 'HIGHLIGHTER', 'BORDER', 'ACCENT', 'LARGE_FORMAT_BASE']);
const OPENED_PDF_PATTERN = /Opened PDF -- (\d+) page/;
const PAGE_PROGRESS_PATTERN = /Page (\d+)\/(\d+):/;
function parseProgressLine(line) {
    const openedMatch = OPENED_PDF_PATTERN.exec(line);
    if (openedMatch)
        return { totalPages: Number(openedMatch[1]) };
    const pageMatch = PAGE_PROGRESS_PATTERN.exec(line);
    if (pageMatch)
        return { currentPage: Number(pageMatch[1]), totalPages: Number(pageMatch[2]) };
    return null;
}
function toPublicImagePath(localPath) {
    const relative = path_1.default.relative(index_1.config.catalog.extractedDir, localPath).split(path_1.default.sep).join('/');
    return `/static/extracted/${relative}`;
}
function resolveExtractedImage(t) {
    if (t.imageStorage === 'drive')
        return t.imageUrl ?? undefined;
    return t.imageLocalPath ? toPublicImagePath(t.imageLocalPath) : undefined;
}
async function uploadAndCreateCatalog(file, input, userId, req) {
    if (!(0, fileSignature_1.isRealPdf)(file.path)) {
        fs_1.default.unlinkSync(file.path);
        throw AppError_1.AppError.badRequest('This file is not actually a valid PDF (failed content verification)');
    }
    const brand = await (0, brand_service_1.resolveBrand)(input);
    if (!brand) {
        throw AppError_1.AppError.badRequest('Could not resolve a brand for this upload');
    }
    const fileHash = await hashFile(file.path);
    const existingDuplicate = await connection_1.prisma.catalog.findFirst({
        where: { brandId: brand.id, fileHash },
        orderBy: { createdAt: 'desc' },
    });
    if (existingDuplicate) {
        fs_1.default.unlink(file.path, () => { });
        throw AppError_1.AppError.conflict('This exact file has already been uploaded for this brand', {
            existingCatalogId: existingDuplicate.id,
            existingFileName: existingDuplicate.fileName,
            existingStatus: existingDuplicate.status,
            existingUploadedAt: existingDuplicate.createdAt,
        });
    }
    const catalog = await connection_1.prisma.catalog.create({
        data: {
            brandId: brand.id,
            fileName: file.originalname,
            filePath: file.path,
            fileHash,
            status: 'PENDING',
            uploadedById: userId,
        },
        include: { brand: true },
    });
    await (0, activityLog_service_1.logActivity)({
        userId,
        action: 'catalog.uploaded',
        entityType: 'Catalog',
        entityId: catalog.id,
        metadata: { fileName: file.originalname, brand: brand.name },
        req,
    });
    extractionQueue.enqueue(catalog.id);
    return catalog;
}
async function runExtraction(catalogId) {
    const catalog = await connection_1.prisma.catalog.findUnique({ where: { id: catalogId }, include: { brand: true } });
    if (!catalog) {
        logger_1.logger.error(`runExtraction called with unknown catalog id ${catalogId}`);
        return;
    }
    await connection_1.prisma.catalog.update({
        where: { id: catalogId },
        data: { status: 'PROCESSING', startedAt: new Date(), currentPage: null, errorMessage: null, processingLog: '' },
    });
    try {
        await runExtractionInner(catalogId, catalog);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger_1.logger.error(`Extraction crashed for catalog ${catalogId}`, { error: message });
        await connection_1.prisma.catalog.update({
            where: { id: catalogId },
            data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
        });
        await (0, activityLog_service_1.logActivity)({
            userId: catalog.uploadedById,
            action: 'catalog.extraction_failed',
            entityType: 'Catalog',
            entityId: catalogId,
            metadata: { error: message },
        });
    }
}
async function runExtractionInner(catalogId, catalog) {
    const outputDir = path_1.default.join(index_1.config.catalog.extractedDir, catalogId);
    fs_1.default.mkdirSync(outputDir, { recursive: true });
    const args = [
        '--pdf', catalog.filePath ?? '',
        '--brand', catalog.brand.name,
        '--catalog-id', catalogId,
        '--output-dir', outputDir,
        '--drive-folder', index_1.config.google.driveRootFolder,
        '--sheet-name', index_1.config.google.sheetName,
    ];
    if (index_1.config.google.serviceAccountKeyPath) {
        args.push('--service-account-key', index_1.config.google.serviceAccountKeyPath);
    }
    const logBuffer = [];
    const appendLog = (line) => {
        logBuffer.push(`[${new Date().toISOString()}] ${line}`);
    };
    const onLine = (line) => {
        appendLog(line);
        const progress = parseProgressLine(line);
        if (!progress)
            return;
        connection_1.prisma.catalog
            .update({ where: { id: catalogId }, data: progress })
            .catch((err) => logger_1.logger.warn(`Failed to persist progress for catalog ${catalogId}`, { error: err.message }));
    };
    const { stdout } = await (0, pythonRunner_1.runPythonScript)({ script: 'extract.py', args, onLine });
    const result = (0, pythonRunner_1.parseResultLine)(stdout, 'RESULT_JSON:');
    const fullLog = logBuffer.join('\n');
    if (!result.success) {
        await connection_1.prisma.catalog.update({
            where: { id: catalogId },
            data: {
                status: 'FAILED',
                errorMessage: result.error ?? 'Extraction failed for an unknown reason',
                processingLog: fullLog,
                completedAt: new Date(),
            },
        });
        await (0, activityLog_service_1.logActivity)({
            userId: catalog.uploadedById,
            action: 'catalog.extraction_failed',
            entityType: 'Catalog',
            entityId: catalogId,
            metadata: { error: result.error },
        });
        return;
    }
    const extractedTiles = result.tiles ?? [];
    const codesInBatch = extractedTiles.map((t) => t.productCode).filter((c) => !!c);
    const existingByCode = codesInBatch.length
        ? await connection_1.prisma.tile.findMany({ where: { brandId: catalog.brandId, productCode: { in: codesInBatch } }, select: { productCode: true } })
        : [];
    const existingCodeSet = new Set(existingByCode.map((t) => t.productCode));
    const existingByName = extractedTiles.length
        ? await connection_1.prisma.tile.findMany({
            where: { brandId: catalog.brandId, name: { in: extractedTiles.map((t) => t.name) } },
            select: { id: true, name: true, size: true, productCode: true, imageUrl: true },
        })
        : [];
    const existingByNameSizeMap = new Map(existingByName.map((t) => [`${t.name}::${t.size ?? ''}`, t]));
    const existingNameSizeSet = new Set(existingByName.map((t) => `${t.name}::${t.size ?? ''}`));
    const seenInThisBatch = new Set();
    let duplicateTilesSkipped = 0;
    const tilesToInsert = [];
    const tilesToCorrect = [];
    for (const t of extractedTiles) {
        const key = t.productCode ? `code:${t.productCode}` : `namesize:${t.name}::${t.size ?? ''}`;
        const isDuplicateWithinBatch = seenInThisBatch.has(key);
        if (isDuplicateWithinBatch) {
            duplicateTilesSkipped += 1;
            continue;
        }
        const nameSizeMatch = existingByNameSizeMap.get(`${t.name}::${t.size ?? ''}`);
        const hasPlaceholderCode = !!t.productCode && !!nameSizeMatch?.productCode?.startsWith('MANUAL-');
        const isMissingImage = !!nameSizeMatch && !nameSizeMatch.imageUrl && !!resolveExtractedImage(t);
        const isPlaceholderToCorrect = hasPlaceholderCode || isMissingImage;
        if (isPlaceholderToCorrect && nameSizeMatch) {
            tilesToCorrect.push({
                id: nameSizeMatch.id,
                tile: t,
                reason: hasPlaceholderCode ? 'placeholder_product_code_replaced' : 'missing_image_filled_in',
            });
            seenInThisBatch.add(key);
            continue;
        }
        const isDuplicateOfExisting = t.productCode ? existingCodeSet.has(t.productCode) : existingNameSizeSet.has(`${t.name}::${t.size ?? ''}`);
        if (isDuplicateOfExisting) {
            duplicateTilesSkipped += 1;
            continue;
        }
        seenInThisBatch.add(key);
        tilesToInsert.push(t);
    }
    if (tilesToInsert.length > 0) {
        await connection_1.prisma.tile.createMany({
            data: tilesToInsert.map((t) => ({
                name: t.name,
                brandId: catalog.brandId,
                catalogId,
                size: t.size ?? undefined,
                finish: t.finish ?? undefined,
                type: VALID_TILE_TYPES.has(t.type) ? t.type : 'BASE',
                colorTone: t.colorTone ?? undefined,
                bestRoom: t.bestRoom ?? undefined,
                productCode: t.productCode ?? undefined,
                imageUrl: resolveExtractedImage(t),
                sourcePage: t.sourcePage ?? undefined,
                imageBbox: t.imageBbox ?? undefined,
            })),
        });
    }
    for (const { id, tile: t, reason } of tilesToCorrect) {
        await connection_1.prisma.tile.update({
            where: { id },
            data: {
                catalogId,
                size: t.size ?? undefined,
                finish: t.finish ?? undefined,
                type: VALID_TILE_TYPES.has(t.type) ? t.type : undefined,
                colorTone: t.colorTone ?? undefined,
                bestRoom: t.bestRoom ?? undefined,
                productCode: t.productCode ?? undefined,
                imageUrl: resolveExtractedImage(t),
                sourcePage: t.sourcePage ?? undefined,
                imageBbox: t.imageBbox ?? undefined,
            },
        });
        await (0, activityLog_service_1.logActivity)({
            userId: catalog.uploadedById,
            action: 'tile.corrected',
            entityType: 'Tile',
            entityId: id,
            metadata: { reason, productCode: t.productCode },
        });
    }
    await connection_1.prisma.catalog.update({
        where: { id: catalogId },
        data: {
            status: 'COMPLETED',
            totalPages: result.totalPages ?? 0,
            currentPage: result.totalPages ?? 0,
            tilesExtracted: tilesToInsert.length,
            duplicateImagesSkipped: result.duplicateImagesSkipped ?? 0,
            duplicateTilesSkipped,
            processingLog: fullLog,
            completedAt: new Date(),
        },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: catalog.uploadedById,
        action: 'catalog.extraction_completed',
        entityType: 'Catalog',
        entityId: catalogId,
        metadata: {
            tilesExtracted: tilesToInsert.length,
            tilesCorrected: tilesToCorrect.length,
            duplicateImagesSkipped: result.duplicateImagesSkipped ?? 0,
            duplicateTilesSkipped,
            warnings: result.warnings ?? [],
            storageMode: result.storageMode,
        },
    });
}
async function retryExtraction(catalogId, userId, req) {
    const catalog = await connection_1.prisma.catalog.findUnique({ where: { id: catalogId } });
    if (!catalog)
        throw AppError_1.AppError.notFound('Catalog not found');
    await connection_1.prisma.catalog.update({
        where: { id: catalogId },
        data: { status: 'PENDING', errorMessage: null, duplicateImagesSkipped: 0, duplicateTilesSkipped: 0 },
    });
    await (0, activityLog_service_1.logActivity)({ userId, action: 'catalog.extraction_retried', entityType: 'Catalog', entityId: catalogId, req });
    extractionQueue.enqueue(catalogId);
    return connection_1.prisma.catalog.findUnique({ where: { id: catalogId }, include: { brand: true } });
}
function withQueueInfo(catalog) {
    return {
        ...catalog,
        queuePosition: catalog.status === 'PENDING' ? extractionQueue.getPosition(catalog.id) : null,
    };
}
async function listCatalogs(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.status ? { status: query.status } : {}),
    };
    const [catalogs, total] = await Promise.all([
        connection_1.prisma.catalog.findMany({
            where,
            include: { brand: true, uploadedBy: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.catalog.count({ where }),
    ]);
    return { catalogs: catalogs.map(withQueueInfo), meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getCatalogById(id) {
    const catalog = await connection_1.prisma.catalog.findUnique({
        where: { id },
        include: { brand: true, uploadedBy: { select: { id: true, name: true } } },
    });
    if (!catalog)
        throw AppError_1.AppError.notFound('Catalog not found');
    return withQueueInfo(catalog);
}
async function getCatalogTiles(catalogId, query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const [tiles, total] = await Promise.all([
        connection_1.prisma.tile.findMany({ where: { catalogId }, skip, take, orderBy: { createdAt: 'asc' } }),
        connection_1.prisma.tile.count({ where: { catalogId } }),
    ]);
    return { tiles, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function deleteCatalog(id, deleteTiles, userId, req) {
    const catalog = await connection_1.prisma.catalog.findUnique({ where: { id } });
    if (!catalog)
        throw AppError_1.AppError.notFound('Catalog not found');
    if (deleteTiles) {
        await connection_1.prisma.tile.deleteMany({ where: { catalogId: id } });
    }
    await connection_1.prisma.catalog.delete({ where: { id } });
    if (catalog.filePath) {
        fs_1.default.unlink(catalog.filePath, () => {
        });
    }
    await (0, activityLog_service_1.logActivity)({
        userId,
        action: 'catalog.deleted',
        entityType: 'Catalog',
        entityId: id,
        metadata: { fileName: catalog.fileName, deletedTiles: deleteTiles },
        req,
    });
}
async function updateExtractedTile(tileId, input, userId, req) {
    const existing = await connection_1.prisma.tile.findUnique({ where: { id: tileId } });
    if (!existing)
        throw AppError_1.AppError.notFound('Tile not found');
    const updated = await connection_1.prisma.tile.update({ where: { id: tileId }, data: input });
    await (0, activityLog_service_1.logActivity)({ userId, action: 'tile.corrected', entityType: 'Tile', entityId: tileId, metadata: { changes: input }, req });
    return updated;
}
async function deleteExtractedTile(tileId, userId, req) {
    const existing = await connection_1.prisma.tile.findUnique({ where: { id: tileId } });
    if (!existing)
        throw AppError_1.AppError.notFound('Tile not found');
    await connection_1.prisma.tile.delete({ where: { id: tileId } });
    await (0, activityLog_service_1.logActivity)({ userId, action: 'tile.deleted', entityType: 'Tile', entityId: tileId, metadata: { name: existing.name }, req });
}
//# sourceMappingURL=catalogExtractor.service.js.map