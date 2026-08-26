import fs from 'fs';
import path from 'path';
import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { logActivity } from './activityLog.service';
import { renderPrintBoardPdf, RenderTile } from './printBoardRenderer.service';
import { renderPrintBoardPng } from './printBoardPngRenderer.service';
import { googleDriveClient } from './googleDrive.service';
import { GeneratePrintBoardInput, UpdatePrintBoardInput, CreatePrintBoardTemplateInput } from '@validators/printBoard.validators';
import { CombinationInput } from '@validators/moodBoard.validators';

function ensureDir() {
  if (!fs.existsSync(config.printBoards.uploadsDir)) {
    fs.mkdirSync(config.printBoards.uploadsDir, { recursive: true });
  }
}

function deleteFileFor(fileUrl: string | null) {
  if (!fileUrl?.startsWith('/static/print-boards/')) return;
  const filename = fileUrl.replace('/static/print-boards/', '');
  fs.unlink(path.join(config.printBoards.uploadsDir, filename), () => {});
}

interface DimensionParams {
  format: 'CASSETTE_PANEL' | 'ACP_SIGNBOARD' | 'MOOD_BOARD_PRINT' | 'CUSTOM';
  layout: 'HERO_IMAGE' | 'TILE_GRID' | 'SIDE_BY_SIDE' | 'CASSETTE_STYLE';
  widthValue: number;
  heightValue: number;
  unit: 'FT' | 'IN' | 'CM' | 'MM';
  dpi: number;
}

/**
 * Resolves the actual dimension params to render with — either from a
 * saved template (optionally overridden field-by-field by anything also
 * present in the request) or from the request's own explicit fields.
 * One resolution path used by both Create and Edit, so a template and a
 * hand-typed request are rendered identically.
 */
async function resolveDimensions(input: {
  templateId?: string;
  format?: string;
  layout?: string;
  widthValue?: number;
  heightValue?: number;
  unit?: string;
  dpi?: number;
}): Promise<DimensionParams> {
  let base: Partial<DimensionParams> = {};

  if (input.templateId) {
    const template = await prisma.printBoardTemplate.findUnique({ where: { id: input.templateId } });
    if (!template) throw AppError.notFound('Print board template not found');
    base = {
      format: template.format as DimensionParams['format'],
      layout: template.layout as DimensionParams['layout'],
      widthValue: template.widthValue,
      heightValue: template.heightValue,
      unit: template.unit as DimensionParams['unit'],
      dpi: template.dpi,
    };
  }

  const resolved: DimensionParams = {
    format: (input.format ?? base.format) as DimensionParams['format'],
    layout: (input.layout ?? base.layout) as DimensionParams['layout'],
    widthValue: input.widthValue ?? base.widthValue ?? 0,
    heightValue: input.heightValue ?? base.heightValue ?? 0,
    unit: (input.unit ?? base.unit) as DimensionParams['unit'],
    dpi: input.dpi ?? base.dpi ?? 300,
  };

  if (!resolved.format || !resolved.layout || !resolved.widthValue || !resolved.heightValue || !resolved.unit) {
    throw AppError.badRequest('Could not resolve complete dimensions — provide a valid templateId or all of format/layout/widthValue/heightValue/unit');
  }

  return resolved;
}

/** Renders a combination at the given dimensions and writes it to disk in the requested format. Shared by Create and Edit. */
async function renderAndSave(idSeed: string, combination: CombinationInput, clientBrief: string, dims: DimensionParams, fileFormat: 'PDF' | 'PNG'): Promise<string> {
  const tileIds = combination.tiles.map((t) => t.tileId);
  const tileDetails = await prisma.tile.findMany({ where: { id: { in: tileIds } }, include: { brand: { select: { name: true } } } });
  const tileById = new Map(tileDetails.map((t) => [t.id, t]));

  const renderTiles: RenderTile[] = combination.tiles.map((t) => {
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

  const bytes = fileFormat === 'PNG' ? await renderPrintBoardPng(renderInput) : await renderPrintBoardPdf(renderInput);
  const extension = fileFormat === 'PNG' ? 'png' : 'pdf';

  ensureDir();
  const filename = `${idSeed}-${Date.now()}.${extension}`;
  fs.writeFileSync(path.join(config.printBoards.uploadsDir, filename), bytes);
  return `/static/print-boards/${filename}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Create Board
// ─────────────────────────────────────────────────────────────────────────

export async function generatePrintBoard(input: GeneratePrintBoardInput, actorId: string, req?: Request) {
  const moodBoard = await prisma.moodBoard.findUnique({ where: { id: input.moodBoardId } });
  if (!moodBoard) throw AppError.notFound('Mood board not found');

  const combinations = moodBoard.combinations as unknown as CombinationInput[];
  const index = input.combinationIndex ?? moodBoard.selectedIndex ?? undefined;

  if (index === undefined) {
    throw AppError.badRequest('This mood board has no approved combination yet — pass combinationIndex explicitly, or approve the board first.');
  }
  if (index >= combinations.length) {
    throw AppError.badRequest(`combinationIndex ${index} is out of range — this board has ${combinations.length} combination(s)`);
  }

  const combination = combinations[index];
  const dims = await resolveDimensions(input);
  const fileUrl = await renderAndSave(moodBoard.id, combination, moodBoard.clientBrief, dims, input.fileFormat);

  const printBoard = await prisma.printBoard.create({
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
      // See the identical cast + comment in errorLog.service.ts —
      // Prisma's Json input type is stricter than a concrete interface.
      tilesSnapshot: combination as unknown as object,
    },
  });

  await logActivity({
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

// ─────────────────────────────────────────────────────────────────────────
// List / Get
// ─────────────────────────────────────────────────────────────────────────

export async function listPrintBoards(query: { page: number; limit: number; moodBoardId?: string; fileFormat?: 'PDF' | 'PNG' }) {
  const { page, limit, skip, take } = getPagination(query);
  const where = {
    ...(query.moodBoardId ? { moodBoardId: query.moodBoardId } : {}),
    ...(query.fileFormat ? { fileFormat: query.fileFormat } : {}),
  };

  const [boards, total] = await Promise.all([
    prisma.printBoard.findMany({
      where,
      include: { createdBy: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.printBoard.count({ where }),
  ]);

  return { boards, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

/**
 * Export History — a real audit trail of every export ACTION (generate,
 * edit, delete), not just the current state of existing PrintBoard rows.
 * Sourced from ActivityLog (the same table Module 4's dashboard reads
 * "recent activity" from) rather than a new table: an edited or deleted
 * board's earlier export events are still visible here even after the
 * underlying row has changed or is gone, which `GET /print-boards`
 * alone can't show.
 */
export async function getExportHistory(query: { page: number; limit: number }) {
  const { page, limit, skip, take } = getPagination(query);
  const where = { action: { in: ['print_board.generated', 'print_board.updated', 'print_board.deleted'] } };

  const [events, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      include: { user: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.activityLog.count({ where }),
  ]);

  return { events, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getPrintBoardById(id: string) {
  const board = await prisma.printBoard.findUnique({ where: { id }, include: { createdBy: { select: { id: true, name: true } } } });
  if (!board) throw AppError.notFound('Print board not found');
  return board;
}

// ─────────────────────────────────────────────────────────────────────────
// Edit Board — changing format/layout/dimensions/dpi means the actual
// file is now wrong, so this genuinely re-renders it (not just a
// metadata patch) and replaces the old file on disk.
// ─────────────────────────────────────────────────────────────────────────

export async function updatePrintBoard(id: string, input: UpdatePrintBoardInput, actorId: string, req?: Request) {
  const existing = await prisma.printBoard.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Print board not found');

  const dims: DimensionParams = {
    format: (input.format ?? existing.format) as DimensionParams['format'],
    layout: (input.layout ?? existing.layout) as DimensionParams['layout'],
    widthValue: input.widthValue ?? existing.widthValue,
    heightValue: input.heightValue ?? existing.heightValue,
    unit: (input.unit ?? existing.unit) as DimensionParams['unit'],
    dpi: input.dpi ?? existing.dpi,
  };

  const combination = existing.tilesSnapshot as unknown as CombinationInput;
  const oldFileUrl = existing.fileUrl;
  const fileUrl = await renderAndSave(existing.moodBoardId ?? 'edited', combination, '', dims, existing.fileFormat as 'PDF' | 'PNG');

  const updated = await prisma.printBoard.update({
    where: { id },
    data: { format: dims.format, layout: dims.layout, widthValue: dims.widthValue, heightValue: dims.heightValue, unit: dims.unit, dpi: dims.dpi, fileUrl },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  deleteFileFor(oldFileUrl);

  await logActivity({
    userId: actorId,
    action: 'print_board.updated',
    entityType: 'PrintBoard',
    entityId: id,
    metadata: { changes: input, dimensions: `${dims.widthValue}${dims.unit}x${dims.heightValue}${dims.unit}` },
    req,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// Delete Board
// ─────────────────────────────────────────────────────────────────────────

export async function deletePrintBoard(id: string, actorId: string, req?: Request) {
  const existing = await prisma.printBoard.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Print board not found');

  await prisma.printBoard.delete({ where: { id } });
  deleteFileFor(existing.fileUrl);

  await logActivity({ userId: actorId, action: 'print_board.deleted', entityType: 'PrintBoard', entityId: id, req });
}

// ─────────────────────────────────────────────────────────────────────────
// Templates — reusable named format/layout/dimension/DPI presets.
// ─────────────────────────────────────────────────────────────────────────

export async function listTemplates() {
  return prisma.printBoardTemplate.findMany({ orderBy: { name: 'asc' } });
}

export async function createTemplate(input: CreatePrintBoardTemplateInput, actorId: string, req?: Request) {
  const existing = await prisma.printBoardTemplate.findUnique({ where: { name: input.name } });
  if (existing) throw AppError.conflict(`A template named "${input.name}" already exists`);

  const template = await prisma.printBoardTemplate.create({ data: { ...input, createdById: actorId } });

  await logActivity({ userId: actorId, action: 'print_board_template.created', entityType: 'PrintBoardTemplate', entityId: template.id, metadata: { name: template.name }, req });

  return template;
}

export async function deleteTemplate(id: string, actorId: string, req?: Request) {
  const existing = await prisma.printBoardTemplate.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Template not found');

  await prisma.printBoardTemplate.delete({ where: { id } });

  await logActivity({ userId: actorId, action: 'print_board_template.deleted', entityType: 'PrintBoardTemplate', entityId: id, metadata: { name: existing.name }, req });
}

// ─────────────────────────────────────────────────────────────────────────
// Google Drive sharing — uploads an already-generated export to a
// dedicated Drive folder and returns a public link, for sending to a
// print shop or customer via WhatsApp/email. Real integration point for
// Module 19's Drive client, not a standalone unused service.
// ─────────────────────────────────────────────────────────────────────────

const DRIVE_EXPORTS_SUBFOLDER = 'Print Board Exports';

export async function shareToDrive(id: string, actorId: string, req?: Request) {
  const board = await prisma.printBoard.findUnique({ where: { id } });
  if (!board) throw AppError.notFound('Print board not found');
  if (!board.fileUrl) throw AppError.badRequest('This print board has no exported file to share');

  // Re-sharing an already-shared board just re-confirms the public
  // permission and returns the same link — cheap and idempotent, so no
  // special-casing needed for "already shared."
  const filename = board.fileUrl.replace('/static/print-boards/', '');
  const localPath = path.join(config.printBoards.uploadsDir, filename);
  if (!fs.existsSync(localPath)) {
    throw AppError.notFound('The exported file is no longer on disk — regenerate the print board first');
  }

  const rootFolder = await googleDriveClient.getOrCreateFolder(config.google.driveRootFolder);
  const exportsFolder = await googleDriveClient.getOrCreateFolder(DRIVE_EXPORTS_SUBFOLDER, rootFolder.id);

  const mimeType = board.fileFormat === 'PNG' ? 'image/png' : 'application/pdf';
  const uploaded = board.driveFileId
    ? { id: board.driveFileId, name: filename }
    : await googleDriveClient.uploadFile({ name: filename, mimeType, content: fs.readFileSync(localPath), parentFolderId: exportsFolder.id });

  const shareUrl = await googleDriveClient.generatePublicLink(uploaded.id);

  const updated = await prisma.printBoard.update({
    where: { id },
    data: { driveFileId: uploaded.id, driveShareUrl: shareUrl },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  await logActivity({
    userId: actorId,
    action: 'print_board.shared_to_drive',
    entityType: 'PrintBoard',
    entityId: id,
    metadata: { driveFileId: uploaded.id },
    req,
  });

  return updated;
}