import { Router } from 'express';
import { z } from 'zod';
import { parse, handler } from '../validate.mjs';
import { requirePermission } from '../services/permission.mjs';
import * as engine from '../import/engine.mjs';
import { googleSheetsConfig, UPLOAD_LIMITS, describeHeaders, readUpload } from '../import/sources.mjs';
import { MASTER_COLUMNS, FIELDS_ABSENT_FROM_SOURCE, OTHER_SHEETS } from '../import/mapping.mjs';
import { AppError } from '../errors.mjs';
import { prisma } from '../../db/client.mjs';

const router = Router();

/* ============================================================
   IMPORT ENDPOINTS
   ============================================================
   Upload is raw bytes rather than multipart: one file, no
   boundary parsing, and no multipart library to keep patched.
   The filename travels in a header.
   ============================================================ */

/** What the frontend needs to know before offering anything. */
router.get('/sources', handler(async (_req, res) => {
  const sheets = googleSheetsConfig();
  res.json({
    sources: [
      {
        type: 'EXCEL_UPLOAD',
        label: 'Excel or CSV upload',
        available: true,
        verified: true,
        accepts: UPLOAD_LIMITS.extensions,
        maxBytes: UPLOAD_LIMITS.maxBytes,
        note: 'Tested end to end. Export the MASTER tab from the catalogue sheet and upload it.',
      },
      {
        type: 'GOOGLE_SHEETS',
        label: 'Connected Google Sheet',
        /* NOT available, and the UI must say so rather than
           offering a button that fails. No credentials and no
           spreadsheet id are configured, and the adapter has
           never run against the real sheet. */
        available: false,
        verified: false,
        missingConfiguration: sheets.missing,
        expectedSheet: sheets.sheetName,
        note: 'Not connected in this environment, and never tested against the live spreadsheet. '
          + 'Download the MASTER tab as .xlsx and upload it instead.',
      },
    ],
    expectedColumns: MASTER_COLUMNS,
    otherSheetsInSource: OTHER_SHEETS,
    fieldsNotInSource: FIELDS_ABSENT_FROM_SOURCE,
  });
}));

/**
 * Upload a file and prepare a batch. Reads, maps, validates and
 * classifies; writes NOTHING to the Product Master.
 */
router.post(
  '/upload',
  requirePermission('product:write'),
  // 20 MB at the parser so an oversized body is refused before
  // it is buffered; the 15 MB business limit is checked after.
  (req, res, next) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        req.destroy();
        next(new AppError('That upload is too large.', { status: 413, code: 'FILE_TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { req.fileBuffer = Buffer.concat(chunks); next(); });
    req.on('error', next);
  },
  handler(async (req, res) => {
    const filename = req.header('x-filename');
    if (!filename) {
      throw new AppError('Send the file name in an x-filename header.', { status: 400, code: 'NO_FILENAME' });
    }
    const result = await engine.prepare({
      sourceType: 'EXCEL_UPLOAD',
      buffer: req.fileBuffer,
      filename,
      sheetName: req.header('x-sheet') || undefined,
    }, req.actor);
    res.status(201).json(result);
  }),
);

/** Inspect a file's headers without creating a batch. */
router.post(
  '/inspect',
  (req, res, next) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { req.fileBuffer = Buffer.concat(chunks); next(); });
    req.on('error', next);
  },
  handler(async (req, res) => {
    const source = await readUpload(req.fileBuffer, req.header('x-filename') || 'upload.xlsx');
    res.json({
      sheetName: source.sheetName,
      availableSheets: source.availableSheets,
      rowCount: source.sourceRowsExpected,
      headers: source.headers,
      analysis: describeHeaders(source.headers),
    });
  }),
);

/** Google Sheets: always refuses, with what is missing. */
router.post('/google-sheets', handler(async (_req, _res) => {
  await engine.prepare({ sourceType: 'GOOGLE_SHEETS' });
}));

router.get('/batches', handler(async (req, res) => {
  res.json(await engine.listBatches({
    page: Number(req.query.page) || 1,
    pageSize: Math.min(Number(req.query.pageSize) || 25, 100),
  }));
}));

router.get('/batches/:id', handler(async (req, res) => {
  res.json(await engine.getBatch(req.params.id));
}));

router.get('/batches/:id/preview', handler(async (req, res) => {
  res.json(await engine.preview(req.params.id, {
    page: Number(req.query.page) || 1,
    pageSize: Math.min(Number(req.query.pageSize) || 50, 200),
    status: req.query.status || undefined,
  }));
}));

const Confirm = z.object({
  onlyRowIds: z.array(z.string().uuid()).optional(),
  /* Importing a row a person has reviewed has to be asked for
     explicitly. A possible duplicate going in because somebody
     clicked the usual button is the failure this whole flow
     exists to prevent. */
  includeReviewed: z.boolean().optional(),
});

router.post('/batches/:id/confirm', requirePermission('product:write'), handler(async (req, res) => {
  res.json(await engine.confirm(req.params.id, parse(Confirm, req.body ?? {}), req.actor));
}));

/** Retry only the rows that failed. */
router.post('/batches/:id/retry', requirePermission('product:write'), handler(async (req, res) => {
  const failed = await prisma.importRow.findMany({
    where: { batchId: req.params.id, status: 'FAILED' },
    select: { id: true },
  });
  if (failed.length === 0) {
    throw new AppError('No failed rows to retry in this batch.', { status: 409, code: 'NOTHING_TO_RETRY' });
  }
  res.json(await engine.confirm(req.params.id, { onlyRowIds: failed.map((r) => r.id) }, req.actor));
}));

/** The error report, as CSV. */
router.get('/batches/:id/errors.csv', handler(async (req, res) => {
  const rows = await prisma.importRow.findMany({
    where: {
      batchId: req.params.id,
      status: { in: ['INCOMPLETE', 'REJECTED', 'FAILED', 'REVIEW_REQUIRED'] },
    },
    orderBy: { sourceRowNumber: 'asc' },
  });

  /* EVERY FIELD IS QUOTED AND ESCAPED, and anything that would
     start a formula gets a leading apostrophe. A product name
     out of a spreadsheet can contain a comma, a quote or a
     newline, and an error report that reopens in Excel as a
     formula would be a nasty way to repay somebody for
     downloading it. */
  const cell = (value) => {
    const text = String(value ?? '');
    const safe = /^[=+\-@]/.test(text) ? "'" + text : text;
    return '"' + safe.replace(/"/g, '""') + '"';
  };

  const lines = [['Source row', 'Status', 'Brand', 'Product name', 'Size', 'Field', 'Problem'].map(cell).join(',')];
  for (const row of rows) {
    const errors = Array.isArray(row.errors) ? row.errors : [];
    const base = [row.sourceRowNumber, row.status, row.mappedData?.brandName, row.mappedData?.name, row.mappedData?.size];
    if (errors.length === 0) {
      lines.push([...base, '', row.lastError ?? ''].map(cell).join(','));
    } else {
      for (const e of errors) lines.push([...base, e.field, e.message].map(cell).join(','));
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import-errors.csv"');
  res.send(lines.join('\n'));
}));

export default router;
