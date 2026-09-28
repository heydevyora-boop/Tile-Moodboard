"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePrintBoard = generatePrintBoard;
exports.listPrintBoards = listPrintBoards;
exports.getExportHistory = getExportHistory;
exports.getPrintBoardById = getPrintBoardById;
exports.updatePrintBoard = updatePrintBoard;
exports.deletePrintBoard = deletePrintBoard;
exports.listTemplates = listTemplates;
exports.createTemplate = createTemplate;
exports.deleteTemplate = deleteTemplate;
exports.shareToDrive = shareToDrive;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
const pagination_1 = require("@utils/pagination");
const activityLog_service_1 = require("./activityLog.service");
const printBoardRenderer_service_1 = require("./printBoardRenderer.service");
const printBoardPngRenderer_service_1 = require("./printBoardPngRenderer.service");
const googleDrive_service_1 = require("./googleDrive.service");
function ensureDir() {
    if (!fs_1.default.existsSync(index_1.config.printBoards.uploadsDir)) {
        fs_1.default.mkdirSync(index_1.config.printBoards.uploadsDir, { recursive: true });
    }
}
function deleteFileFor(fileUrl) {
    if (!fileUrl?.startsWith('/static/print-boards/'))
        return;
    const filename = fileUrl.replace('/static/print-boards/', '');
    fs_1.default.unlink(path_1.default.join(index_1.config.printBoards.uploadsDir, filename), () => { });
}
async function resolveDimensions(input) {
    let base = {};
    if (input.templateId) {
        const template = await connection_1.prisma.printBoardTemplate.findUnique({ where: { id: input.templateId } });
        if (!template)
            throw AppError_1.AppError.notFound('Print board template not found');
        base = {
            format: template.format,
            layout: template.layout,
            widthValue: template.widthValue,
            heightValue: template.heightValue,
            unit: template.unit,
            dpi: template.dpi,
        };
    }
    const resolved = {
        format: (input.format ?? base.format),
        layout: (input.layout ?? base.layout),
        widthValue: input.widthValue ?? base.widthValue ?? 0,
        heightValue: input.heightValue ?? base.heightValue ?? 0,
        unit: (input.unit ?? base.unit),
        dpi: input.dpi ?? base.dpi ?? 300,
    };
    if (!resolved.format || !resolved.layout || !resolved.widthValue || !resolved.heightValue || !resolved.unit) {
        throw AppError_1.AppError.badRequest('Could not resolve complete dimensions — provide a valid templateId or all of format/layout/widthValue/heightValue/unit');
    }
    return resolved;
}
async function renderAndSave(idSeed, combination, clientBrief, dims, fileFormat) {
    const tileIds = combination.tiles.map((t) => t.tileId);
    const tileDetails = await connection_1.prisma.tile.findMany({ where: { id: { in: tileIds } }, include: { brand: { select: { name: true } } } });
    const tileById = new Map(tileDetails.map((t) => [t.id, t]));
    const renderTiles = combination.tiles.map((t) => {
        const detail = tileById.get(t.tileId);
        return {
            role: t.role,
            name: t.name || detail?.name || 'Unknown tile',
            brandName: detail?.brand.name,
            size: detail?.size,
            colorTone: detail?.colorTone,
        };
    });
    const renderInput = {
        boardName: combination.board_name,
        clientBrief,
        groutRecommendation: combination.grout_recommendation,
        tiles: renderTiles,
        format: dims.format,
        layout: dims.layout,
        widthValue: dims.widthValue,
        heightValue: dims.heightValue,
        unit: dims.unit,
        dpi: dims.dpi,
    };
    const bytes = fileFormat === 'PNG' ? await (0, printBoardPngRenderer_service_1.renderPrintBoardPng)(renderInput) : await (0, printBoardRenderer_service_1.renderPrintBoardPdf)(renderInput);
    const extension = fileFormat === 'PNG' ? 'png' : 'pdf';
    ensureDir();
    const filename = `${idSeed}-${Date.now()}.${extension}`;
    fs_1.default.writeFileSync(path_1.default.join(index_1.config.printBoards.uploadsDir, filename), bytes);
    return `/static/print-boards/${filename}`;
}
async function generatePrintBoard(input, actorId, req) {
    const moodBoard = await connection_1.prisma.moodBoard.findUnique({ where: { id: input.moodBoardId } });
    if (!moodBoard)
        throw AppError_1.AppError.notFound('Mood board not found');
    const combinations = moodBoard.combinations;
    const index = input.combinationIndex ?? moodBoard.selectedIndex ?? undefined;
    if (index === undefined) {
        throw AppError_1.AppError.badRequest('This mood board has no approved combination yet — pass combinationIndex explicitly, or approve the board first.');
    }
    if (index >= combinations.length) {
        throw AppError_1.AppError.badRequest(`combinationIndex ${index} is out of range — this board has ${combinations.length} combination(s)`);
    }
    const combination = combinations[index];
    const dims = await resolveDimensions(input);
    const fileUrl = await renderAndSave(moodBoard.id, combination, moodBoard.clientBrief, dims, input.fileFormat);
    const printBoard = await connection_1.prisma.printBoard.create({
        data: {
            moodBoardId: moodBoard.id,
            createdById: actorId,
            format: dims.format,
            layout: dims.layout,
            widthValue: dims.widthValue,
            heightValue: dims.heightValue,
            unit: dims.unit,
            dpi: dims.dpi,
            fileFormat: input.fileFormat,
            fileUrl,
            tilesSnapshot: combination,
        },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'print_board.generated',
        entityType: 'PrintBoard',
        entityId: printBoard.id,
        metadata: {
            moodBoardId: moodBoard.id,
            format: dims.format,
            layout: dims.layout,
            dpi: dims.dpi,
            dimensions: `${dims.widthValue}${dims.unit}x${dims.heightValue}${dims.unit}`,
            viaTemplate: !!input.templateId,
        },
        req,
    });
    return printBoard;
}
async function listPrintBoards(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.moodBoardId ? { moodBoardId: query.moodBoardId } : {}),
        ...(query.fileFormat ? { fileFormat: query.fileFormat } : {}),
    };
    const [boards, total] = await Promise.all([
        connection_1.prisma.printBoard.findMany({
            where,
            include: { createdBy: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.printBoard.count({ where }),
    ]);
    return { boards, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getExportHistory(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = { action: { in: ['print_board.generated', 'print_board.updated', 'print_board.deleted'] } };
    const [events, total] = await Promise.all([
        connection_1.prisma.activityLog.findMany({
            where,
            include: { user: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.activityLog.count({ where }),
    ]);
    return { events, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getPrintBoardById(id) {
    const board = await connection_1.prisma.printBoard.findUnique({ where: { id }, include: { createdBy: { select: { id: true, name: true } } } });
    if (!board)
        throw AppError_1.AppError.notFound('Print board not found');
    return board;
}
async function updatePrintBoard(id, input, actorId, req) {
    const existing = await connection_1.prisma.printBoard.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Print board not found');
    const dims = {
        format: (input.format ?? existing.format),
        layout: (input.layout ?? existing.layout),
        widthValue: input.widthValue ?? existing.widthValue,
        heightValue: input.heightValue ?? existing.heightValue,
        unit: (input.unit ?? existing.unit),
        dpi: input.dpi ?? existing.dpi,
    };
    const combination = existing.tilesSnapshot;
    const oldFileUrl = existing.fileUrl;
    const fileUrl = await renderAndSave(existing.moodBoardId ?? 'edited', combination, '', dims, existing.fileFormat);
    const updated = await connection_1.prisma.printBoard.update({
        where: { id },
        data: { format: dims.format, layout: dims.layout, widthValue: dims.widthValue, heightValue: dims.heightValue, unit: dims.unit, dpi: dims.dpi, fileUrl },
        include: { createdBy: { select: { id: true, name: true } } },
    });
    deleteFileFor(oldFileUrl);
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'print_board.updated',
        entityType: 'PrintBoard',
        entityId: id,
        metadata: { changes: input, dimensions: `${dims.widthValue}${dims.unit}x${dims.heightValue}${dims.unit}` },
        req,
    });
    return updated;
}
async function deletePrintBoard(id, actorId, req) {
    const existing = await connection_1.prisma.printBoard.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Print board not found');
    await connection_1.prisma.printBoard.delete({ where: { id } });
    deleteFileFor(existing.fileUrl);
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'print_board.deleted', entityType: 'PrintBoard', entityId: id, req });
}
async function listTemplates() {
    return connection_1.prisma.printBoardTemplate.findMany({ orderBy: { name: 'asc' } });
}
async function createTemplate(input, actorId, req) {
    const existing = await connection_1.prisma.printBoardTemplate.findUnique({ where: { name: input.name } });
    if (existing)
        throw AppError_1.AppError.conflict(`A template named "${input.name}" already exists`);
    const template = await connection_1.prisma.printBoardTemplate.create({ data: { ...input, createdById: actorId } });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'print_board_template.created', entityType: 'PrintBoardTemplate', entityId: template.id, metadata: { name: template.name }, req });
    return template;
}
async function deleteTemplate(id, actorId, req) {
    const existing = await connection_1.prisma.printBoardTemplate.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Template not found');
    await connection_1.prisma.printBoardTemplate.delete({ where: { id } });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'print_board_template.deleted', entityType: 'PrintBoardTemplate', entityId: id, metadata: { name: existing.name }, req });
}
const DRIVE_EXPORTS_SUBFOLDER = 'Print Board Exports';
async function shareToDrive(id, actorId, req) {
    const board = await connection_1.prisma.printBoard.findUnique({ where: { id } });
    if (!board)
        throw AppError_1.AppError.notFound('Print board not found');
    if (!board.fileUrl)
        throw AppError_1.AppError.badRequest('This print board has no exported file to share');
    const filename = board.fileUrl.replace('/static/print-boards/', '');
    const localPath = path_1.default.join(index_1.config.printBoards.uploadsDir, filename);
    if (!fs_1.default.existsSync(localPath)) {
        throw AppError_1.AppError.notFound('The exported file is no longer on disk — regenerate the print board first');
    }
    const rootFolder = await googleDrive_service_1.googleDriveClient.getOrCreateFolder(index_1.config.google.driveRootFolder);
    const exportsFolder = await googleDrive_service_1.googleDriveClient.getOrCreateFolder(DRIVE_EXPORTS_SUBFOLDER, rootFolder.id);
    const mimeType = board.fileFormat === 'PNG' ? 'image/png' : 'application/pdf';
    const uploaded = board.driveFileId
        ? { id: board.driveFileId, name: filename }
        : await googleDrive_service_1.googleDriveClient.uploadFile({ name: filename, mimeType, content: fs_1.default.readFileSync(localPath), parentFolderId: exportsFolder.id });
    const shareUrl = await googleDrive_service_1.googleDriveClient.generatePublicLink(uploaded.id);
    const updated = await connection_1.prisma.printBoard.update({
        where: { id },
        data: { driveFileId: uploaded.id, driveShareUrl: shareUrl },
        include: { createdBy: { select: { id: true, name: true } } },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'print_board.shared_to_drive',
        entityType: 'PrintBoard',
        entityId: id,
        metadata: { driveFileId: uploaded.id },
        req,
    });
    return updated;
}
//# sourceMappingURL=printBoard.service.js.map