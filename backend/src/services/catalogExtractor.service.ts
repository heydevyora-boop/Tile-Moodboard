import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { logger } from '@utils/logger';
import { runPythonScript, parseResultLine } from '@utils/pythonRunner';
import { isRealPdf } from '@utils/fileSignature';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { logActivity } from './activityLog.service';
import { resolveBrand } from './brand.service';
import { getExtractionQueue } from './extractionQueue.service';
import {
  UploadCatalogInput,
  ListCatalogsQuery,
  ListCatalogTilesQuery,
  UpdateExtractedTileInput,
} from '@validators/catalogExtractor.validators';

interface ExtractedTile {
  name: string;
  size: string | null;
  finish: string | null;
  type: string;
  colorTone: string | null;
  bestRoom: string | null;
  productCode: string | null;
  sourcePage: number;
  imageStorage: 'local' | 'drive';
  imageUrl: string | null;
  imageLocalPath: string | null;
}

interface ExtractionResult {
  success: boolean;
  catalogId: string | null;
  brand?: string;
  totalPages?: number;
  tilesExtracted?: number;
  tiles?: ExtractedTile[];
  warnings?: string[];
  duplicateImagesSkipped?: number;
  storageMode?: 'local' | 'drive';
  error?: string;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// One queue for the whole process — extraction jobs across all catalogs
// share the same concurrency limit, not one queue per catalog.
const extractionQueue = getExtractionQueue(config.catalog.extractionConcurrency, runExtraction);

/** Admin-visible snapshot of the catalog extraction queue — depth/running from the in-process queue, plus real status counts from the DB so a restart doesn't lose the picture. */
export async function getExtractionQueueStats() {
  const [pending, processing, completed, failed] = await Promise.all([
    prisma.catalog.count({ where: { status: 'PENDING' } }),
    prisma.catalog.count({ where: { status: 'PROCESSING' } }),
    prisma.catalog.count({ where: { status: 'COMPLETED' } }),
    prisma.catalog.count({ where: { status: 'FAILED' } }),
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

/**
 * Parses extract.py's human-readable PROGRESS lines for the two shapes
 * that carry page-count information, so the Catalog row can be updated
 * live as extraction runs — this is what turns "PROCESSING" from a single
 * opaque state into an actual N-of-M progress the frontend can show.
 * Anything else on a PROGRESS line is just for the logs.
 */
export function parseProgressLine(line: string): { totalPages?: number; currentPage?: number } | null {
  const openedMatch = OPENED_PDF_PATTERN.exec(line);
  if (openedMatch) return { totalPages: Number(openedMatch[1]) };

  const pageMatch = PAGE_PROGRESS_PATTERN.exec(line);
  if (pageMatch) return { currentPage: Number(pageMatch[1]), totalPages: Number(pageMatch[2]) };

  return null;
}

/** Converts an absolute local file path under the extracted-images dir into a URL this server can actually serve (see the /static/extracted mount in app.ts). */
function toPublicImagePath(localPath: string): string {
  const relative = path.relative(config.catalog.extractedDir, localPath).split(path.sep).join('/');
  return `/static/extracted/${relative}`;
}

export async function uploadAndCreateCatalog(file: Express.Multer.File, input: UploadCatalogInput, userId: string, req?: Request) {
  if (!isRealPdf(file.path)) {
    fs.unlinkSync(file.path); // don't leave a rejected file sitting on disk
    throw AppError.badRequest('This file is not actually a valid PDF (failed content verification)');
  }

  const brand = await resolveBrand(input);
  if (!brand) {
    throw AppError.badRequest('Could not resolve a brand for this upload');
  }

  const fileHash = await hashFile(file.path);

  // Detect duplicates: has this exact PDF already been uploaded for this
  // brand? Catches the common accident of re-uploading the same catalog
  // (e.g. a staff member unsure whether a previous upload worked). We
  // check the file's content hash, not just its name, so a renamed copy
  // of the same PDF is still caught.
  const existingDuplicate = await prisma.catalog.findFirst({
    where: { brandId: brand.id, fileHash },
    orderBy: { createdAt: 'desc' },
  });

  if (existingDuplicate) {
    // Clean up the just-uploaded file — we're not going to use it.
    fs.unlink(file.path, () => {});
    throw AppError.conflict('This exact file has already been uploaded for this brand', {
      existingCatalogId: existingDuplicate.id,
      existingFileName: existingDuplicate.fileName,
      existingStatus: existingDuplicate.status,
      existingUploadedAt: existingDuplicate.createdAt,
    });
  }

  const catalog = await prisma.catalog.create({
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

  await logActivity({
    userId,
    action: 'catalog.uploaded',
    entityType: 'Catalog',
    entityId: catalog.id,
    metadata: { fileName: file.originalname, brand: brand.name },
    req,
  });

  // Queued, not fired-and-forgotten directly: bounds how many Python
  // extraction subprocesses run at once (CATALOG_EXTRACTION_CONCURRENCY),
  // so a burst of uploads doesn't spawn one process per file and choke
  // the server. The HTTP response still returns immediately with status
  // PENDING; the frontend polls for PROCESSING -> COMPLETED/FAILED.
  extractionQueue.enqueue(catalog.id);

  return catalog;
}

export async function runExtraction(catalogId: string): Promise<void> {
  const catalog = await prisma.catalog.findUnique({ where: { id: catalogId }, include: { brand: true } });
  if (!catalog) {
    logger.error(`runExtraction called with unknown catalog id ${catalogId}`);
    return;
  }

  await prisma.catalog.update({
    where: { id: catalogId },
    data: { status: 'PROCESSING', startedAt: new Date(), currentPage: null, errorMessage: null, processingLog: '' },
  });

  try {
    await runExtractionInner(catalogId, catalog);
  } catch (err) {
    // Anything thrown here — a missing/deleted brand, a filesystem error
    // creating outputDir, the Python bridge itself throwing instead of
    // returning a { success: false } result — must still leave the
    // catalog in a real, visible FAILED state with an error message.
    // Without this, the extraction queue's own catch() only logs and
    // moves on (see extractionQueue.service.ts), silently leaving the
    // catalog stuck at PROCESSING forever with nothing in the UI
    // explaining why. A real bug found and fixed in Module 28's
    // integration pass.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Extraction crashed for catalog ${catalogId}`, { error: message });
    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
    });
    await logActivity({
      userId: catalog.uploadedById,
      action: 'catalog.extraction_failed',
      entityType: 'Catalog',
      entityId: catalogId,
      metadata: { error: message },
    });
  }
}

async function runExtractionInner(catalogId: string, catalog: Awaited<ReturnType<typeof prisma.catalog.findUnique>> & { brand: { name: string } }): Promise<void> {
  const outputDir = path.join(config.catalog.extractedDir, catalogId);
  fs.mkdirSync(outputDir, { recursive: true });

  const args = [
    '--pdf', catalog.filePath ?? '',
    '--brand', catalog.brand.name,
    '--catalog-id', catalogId,
    '--output-dir', outputDir,
    '--drive-folder', config.google.driveRootFolder,
    '--sheet-name', config.google.sheetName,
  ];
  if (config.google.serviceAccountKeyPath) {
    args.push('--service-account-key', config.google.serviceAccountKeyPath);
  }

  // Every PROGRESS line gets appended to an in-memory buffer, written to
  // the DB once at the end as the full run log — not per-line, since a
  // multi-hundred-page catalog could otherwise mean hundreds of writes.
  // Progress (currentPage/totalPages) is still persisted live, separately,
  // since that's what a polling frontend actually needs in real time.
  const logBuffer: string[] = [];
  const appendLog = (line: string) => {
    logBuffer.push(`[${new Date().toISOString()}] ${line}`);
  };

  const onLine = (line: string) => {
    appendLog(line);
    const progress = parseProgressLine(line);
    if (!progress) return;
    prisma.catalog
      .update({ where: { id: catalogId }, data: progress })
      .catch((err: Error) => logger.warn(`Failed to persist progress for catalog ${catalogId}`, { error: err.message }));
  };

  const { stdout } = await runPythonScript({ script: 'extract.py', args, onLine });
  const result = parseResultLine<ExtractionResult>(stdout, 'RESULT_JSON:');
  const fullLog = logBuffer.join('\n');

  if (!result.success) {
    await prisma.catalog.update({
      where: { id: catalogId },
      data: {
        status: 'FAILED',
        errorMessage: result.error ?? 'Extraction failed for an unknown reason',
        processingLog: fullLog,
        completedAt: new Date(),
      },
    });
    await logActivity({
      userId: catalog.uploadedById,
      action: 'catalog.extraction_failed',
      entityType: 'Catalog',
      entityId: catalogId,
      metadata: { error: result.error },
    });
    return;
  }

  const extractedTiles = result.tiles ?? [];

  // Cross-run duplicate detection: has a tile matching this one already
  // been persisted for this brand (e.g. from a previous upload of the
  // same catalog family, or a page that legitimately repeats a product)?
  // Matched by product code when available (the strongest signal); falls
  // back to name+size when a code wasn't detected. This runs against the
  // DB, not just within this extraction, so it catches duplicates across
  // separate uploads too — unlike the image-hash check in extract.py,
  // which only catches duplicates within a single PDF.
  const codesInBatch = extractedTiles.map((t) => t.productCode).filter((c): c is string => !!c);
  const existingByCode = codesInBatch.length
    ? await prisma.tile.findMany({ where: { brandId: catalog.brandId, productCode: { in: codesInBatch } }, select: { productCode: true } })
    : [];
  const existingCodeSet = new Set(existingByCode.map((t) => t.productCode));

  const namesSizesInBatch = extractedTiles.filter((t) => !t.productCode).map((t) => `${t.name}::${t.size ?? ''}`);
  const existingByNameSize = namesSizesInBatch.length
    ? await prisma.tile.findMany({ where: { brandId: catalog.brandId, name: { in: extractedTiles.map((t) => t.name) } }, select: { name: true, size: true } })
    : [];
  const existingNameSizeSet = new Set(existingByNameSize.map((t) => `${t.name}::${t.size ?? ''}`));

  const seenInThisBatch = new Set<string>();
  let duplicateTilesSkipped = 0;
  const tilesToInsert = extractedTiles.filter((t) => {
    const key = t.productCode ? `code:${t.productCode}` : `namesize:${t.name}::${t.size ?? ''}`;

    const isDuplicateOfExisting = t.productCode ? existingCodeSet.has(t.productCode) : existingNameSizeSet.has(`${t.name}::${t.size ?? ''}`);
    const isDuplicateWithinBatch = seenInThisBatch.has(key);

    if (isDuplicateOfExisting || isDuplicateWithinBatch) {
      duplicateTilesSkipped += 1;
      return false;
    }
    seenInThisBatch.add(key);
    return true;
  });

  if (tilesToInsert.length > 0) {
    await prisma.tile.createMany({
      data: tilesToInsert.map((t) => ({
        name: t.name,
        brandId: catalog.brandId,
        catalogId,
        size: t.size ?? undefined,
        finish: t.finish ?? undefined,
        type: VALID_TILE_TYPES.has(t.type) ? (t.type as never) : 'BASE',
        colorTone: t.colorTone ?? undefined,
        bestRoom: t.bestRoom ?? undefined,
        productCode: t.productCode ?? undefined,
        imageUrl: t.imageStorage === 'drive' ? (t.imageUrl ?? undefined) : t.imageLocalPath ? toPublicImagePath(t.imageLocalPath) : undefined,
      })),
    });
  }

  await prisma.catalog.update({
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

  await logActivity({
    userId: catalog.uploadedById,
    action: 'catalog.extraction_completed',
    entityType: 'Catalog',
    entityId: catalogId,
    metadata: {
      tilesExtracted: tilesToInsert.length,
      duplicateImagesSkipped: result.duplicateImagesSkipped ?? 0,
      duplicateTilesSkipped,
      warnings: result.warnings ?? [],
      storageMode: result.storageMode,
    },
  });
}

export async function retryExtraction(catalogId: string, userId: string, req?: Request) {
  const catalog = await prisma.catalog.findUnique({ where: { id: catalogId } });
  if (!catalog) throw AppError.notFound('Catalog not found');

  await prisma.catalog.update({
    where: { id: catalogId },
    data: { status: 'PENDING', errorMessage: null, duplicateImagesSkipped: 0, duplicateTilesSkipped: 0 },
  });
  await logActivity({ userId, action: 'catalog.extraction_retried', entityType: 'Catalog', entityId: catalogId, req });

  extractionQueue.enqueue(catalogId);

  return prisma.catalog.findUnique({ where: { id: catalogId }, include: { brand: true } });
}

function withQueueInfo<T extends { id: string; status: string }>(catalog: T): T & { queuePosition: number | null } {
  return {
    ...catalog,
    queuePosition: catalog.status === 'PENDING' ? extractionQueue.getPosition(catalog.id) : null,
  };
}

export async function listCatalogs(query: ListCatalogsQuery) {
  const { page, limit, skip, take } = getPagination(query);
  const where = {
    ...(query.brandId ? { brandId: query.brandId } : {}),
    ...(query.status ? { status: query.status } : {}),
  };

  const [catalogs, total] = await Promise.all([
    prisma.catalog.findMany({
      where,
      include: { brand: true, uploadedBy: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.catalog.count({ where }),
  ]);

  return { catalogs: catalogs.map(withQueueInfo), meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getCatalogById(id: string) {
  const catalog = await prisma.catalog.findUnique({
    where: { id },
    include: { brand: true, uploadedBy: { select: { id: true, name: true } } },
  });
  if (!catalog) throw AppError.notFound('Catalog not found');
  return withQueueInfo(catalog);
}

export async function getCatalogTiles(catalogId: string, query: ListCatalogTilesQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const [tiles, total] = await Promise.all([
    prisma.tile.findMany({ where: { catalogId }, skip, take, orderBy: { createdAt: 'asc' } }),
    prisma.tile.count({ where: { catalogId } }),
  ]);

  return { tiles, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function deleteCatalog(id: string, deleteTiles: boolean, userId: string, req?: Request) {
  const catalog = await prisma.catalog.findUnique({ where: { id } });
  if (!catalog) throw AppError.notFound('Catalog not found');

  if (deleteTiles) {
    // Deliberately opt-in: deleting tiles cascades to any mood boards that
    // already used them (MoodBoardTile has onDelete: Cascade on tileId).
    // Default behavior (deleteTiles=false) just detaches them instead
    // (Tile.catalogId is nullable, onDelete: SetNull), which is safe.
    await prisma.tile.deleteMany({ where: { catalogId: id } });
  }

  await prisma.catalog.delete({ where: { id } });

  if (catalog.filePath) {
    fs.unlink(catalog.filePath, () => {
      /* best-effort cleanup — a leftover PDF on disk isn't worth failing the request over */
    });
  }

  await logActivity({
    userId,
    action: 'catalog.deleted',
    entityType: 'Catalog',
    entityId: id,
    metadata: { fileName: catalog.fileName, deletedTiles: deleteTiles },
    req,
  });
}

export async function updateExtractedTile(tileId: string, input: UpdateExtractedTileInput, userId: string, req?: Request) {
  const existing = await prisma.tile.findUnique({ where: { id: tileId } });
  if (!existing) throw AppError.notFound('Tile not found');

  const updated = await prisma.tile.update({ where: { id: tileId }, data: input });

  await logActivity({ userId, action: 'tile.corrected', entityType: 'Tile', entityId: tileId, metadata: { changes: input }, req });

  return updated;
}

export async function deleteExtractedTile(tileId: string, userId: string, req?: Request) {
  const existing = await prisma.tile.findUnique({ where: { id: tileId } });
  if (!existing) throw AppError.notFound('Tile not found');

  await prisma.tile.delete({ where: { id: tileId } });

  await logActivity({ userId, action: 'tile.deleted', entityType: 'Tile', entityId: tileId, metadata: { name: existing.name }, req });
}
