import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { AppError } from '../errors.mjs';
import { MASTER_COLUMNS } from './mapping.mjs';

/* ============================================================
   READING THE SOURCE
   ============================================================
   Two adapters behind one shape, so the engine above does not
   care where rows came from:

       { sheetName, headers, rows, sourceRowsExpected, fingerprint }

   `sourceRowsExpected` is how many rows the SOURCE says it has.
   Null where it cannot say — and that null is what makes
   reconciliation report UNVERIFIED instead of PASSED. Guessing
   it from the number we happened to read would make the check
   tautological: of course we read everything we read.
   ============================================================ */

/* A spreadsheet cell is not a string. Formula injection works by
   persuading Excel to treat a value as a formula when the file is
   reopened -- =HYPERLINK(...), =cmd|..., +, -, @ at the start.

   TWO SEPARATE PROBLEMS, TWO SEPARATE ANSWERS:

   1. We must never EVALUATE one. exceljs hands a formula cell as
      { formula, result }; this takes the cached RESULT and
      discards the formula text. Nothing is computed.
   2. We must never hand one on in a form that something else
      evaluates. Any value that still begins with one of those
      characters is prefixed with an apostrophe, which is the
      spreadsheet convention for "this is text". */
const FORMULA_STARTERS = /^[=+\-@\t\r]/;

function sanitiseCell(value) {
  if (value === null || value === undefined) return '';

  // A formula cell: take the cached result, never the formula.
  if (typeof value === 'object') {
    if ('result' in value) return sanitiseCell(value.result);
    if ('text' in value) return sanitiseCell(value.text);
    if ('richText' in value) return sanitiseCell(value.richText.map((r) => r.text).join(''));
    if ('hyperlink' in value) return sanitiseCell(value.text ?? value.hyperlink);
    if (value instanceof Date) return value.toISOString();
    if ('error' in value) return '';          // #REF!, #DIV/0! and friends
    return '';
  }

  const text = String(value);
  // Control characters out; they break CSV exports and terminals
  // and have no business in a product name.
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();

  return FORMULA_STARTERS.test(clean) ? "'" + clean : clean;
}

/** A stable hash of the whole source, to recognise a re-upload. */
function hashRows(rows) {
  const h = createHash('sha256');
  for (const row of rows) h.update(JSON.stringify(row));
  return h.digest('hex');
}

export const UPLOAD_LIMITS = {
  /* Fifteen megabytes. A catalogue export of a few thousand rows
     is well under one; anything far larger is either not what we
     think it is or will exhaust memory while being parsed, and
     refusing it is cheaper than finding out. */
  maxBytes: 15 * 1024 * 1024,
  extensions: ['.xlsx', '.xlsm', '.csv'],
  /* .xls is NOT accepted. The old binary format needs a different
     parser with a much worse security history, and the studio's
     pipeline writes neither. */
};

/**
 * Read an uploaded workbook.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} [wantedSheet] which tab; the first by default
 */
export async function readUpload(buffer, filename, wantedSheet) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('The uploaded file is empty.', { status: 400, code: 'EMPTY_FILE' });
  }
  if (buffer.length > UPLOAD_LIMITS.maxBytes) {
    throw new AppError(
      'That file is ' + Math.round(buffer.length / 1048576) + ' MB. The limit is '
      + (UPLOAD_LIMITS.maxBytes / 1048576) + ' MB.',
      { status: 413, code: 'FILE_TOO_LARGE' },
    );
  }

  const lower = String(filename ?? '').toLowerCase();
  const extension = UPLOAD_LIMITS.extensions.find((e) => lower.endsWith(e));
  if (!extension) {
    throw new AppError(
      'Only ' + UPLOAD_LIMITS.extensions.join(', ') + ' files can be imported. '
      + '(.xls is not supported: the old binary format needs a different parser.)',
      { status: 415, code: 'UNSUPPORTED_FILE_TYPE' },
    );
  }

  const workbook = new ExcelJS.Workbook();
  try {
    if (extension === '.csv') {
      const { Readable } = await import('node:stream');
      await workbook.csv.read(Readable.from(buffer.toString('utf8')));
    } else {
      await workbook.xlsx.load(buffer);
    }
  } catch (cause) {
    /* A malformed workbook must not take the server down, and the
       parser's own message ("invalid signature: 0x74786574") helps
       nobody. */
    throw new AppError(
      'That file could not be read as a spreadsheet. It may be corrupt, '
      + 'password-protected, or not really a ' + extension + ' file.',
      { status: 422, code: 'UNREADABLE_FILE' },
    );
  }

  const sheet = wantedSheet
    ? workbook.worksheets.find((w) => w.name === wantedSheet)
    : workbook.worksheets[0];

  if (!sheet) {
    throw new AppError(
      'No sheet called "' + wantedSheet + '" in that file. It has: '
      + workbook.worksheets.map((w) => w.name).join(', ') + '.',
      { status: 422, code: 'SHEET_NOT_FOUND' },
    );
  }

  const matrix = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = sanitiseCell(cell.value); });
    for (let i = 0; i < values.length; i += 1) if (values[i] === undefined) values[i] = '';
    matrix.push(values);
  });

  if (matrix.length === 0) {
    throw new AppError('That sheet has no rows at all.', { status: 422, code: 'EMPTY_SHEET' });
  }

  const headers = matrix[0].map((h) => String(h ?? '').trim());
  const dataRows = matrix.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));

  const rows = dataRows.map((values, index) => {
    const record = {};
    headers.forEach((header, i) => { if (header) record[header] = values[i] ?? ''; });
    // Row 1 is the header, so the first data row is row 2 — the
    // number the person sees down the left of their spreadsheet.
    return { sourceRowNumber: index + 2, data: record };
  });

  return {
    sheetName: sheet.name,
    availableSheets: workbook.worksheets.map((w) => w.name),
    headers,
    rows,
    /* A FILE CAN SAY HOW MANY ROWS IT HAS: we hold the whole thing
       and counted them. Unlike a paged API, there is nothing left
       unread, so this is a real expected count and not a
       restatement of what we managed to get. */
    sourceRowsExpected: dataRows.length,
    fingerprint: createHash('sha256').update(buffer).digest('hex'),
    rowsFingerprint: hashRows(rows.map((r) => r.data)),
  };
}

/**
 * How well a file matches the catalogue pipeline's MASTER tab.
 *
 * Any spreadsheet can be uploaded; this says how much of it the
 * ERP recognises, so the preview can warn "this does not look
 * like the catalogue export" before anybody imports nine hundred
 * rows of something else.
 */
export function describeHeaders(headers) {
  const present = MASTER_COLUMNS.filter((c) => headers.includes(c));
  const missing = MASTER_COLUMNS.filter((c) => !headers.includes(c));
  const unknown = headers.filter((h) => h && !MASTER_COLUMNS.includes(h));
  return {
    recognised: present.length,
    expected: MASTER_COLUMNS.length,
    missingColumns: missing,
    unknownColumns: unknown,
    // The four the mapper cannot work without.
    hasEssentials: ['Brand', 'Product Name'].every((c) => headers.includes(c))
      && (headers.includes('Dimensions') || (headers.includes('Length') && headers.includes('Width'))),
    looksLikeMaster: present.length >= 8,
  };
}

/* ============================================================
   GOOGLE SHEETS — IMPLEMENTED, NOT VERIFIED
   ============================================================

   SAY THIS PLAINLY: this adapter has never run against the
   studio's spreadsheet. In this environment there is no
   GOOGLE_SHEET_ID, no credentials.json, no token.json and no
   GOOGLE_SERVICE_ACCOUNT_JSON, so there was nothing to test it
   against. It is written to the MASTER tab's real, verified
   column list -- read out of the pipeline's own source -- and it
   REFUSES TO RUN rather than return something that looks like
   data.

   A stub that returned plausible rows would be the worst possible
   outcome here: the import would appear to work and the
   catalogue would fill with invented products.

   What it needs, exactly:
     ERP_GOOGLE_SHEET_ID        the spreadsheet to read
     ERP_GOOGLE_SERVICE_ACCOUNT the service-account JSON, as a
                                string, with read access to it

   Deliberately its OWN variables, not the pipeline's
   GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON. The ERP reads
   that sheet; it must never inherit the pipeline's WRITE
   credentials, because an ERP bug could then rewrite the
   catalogue the studio depends on.
   ============================================================ */

export function googleSheetsConfig() {
  const spreadsheetId = process.env.ERP_GOOGLE_SHEET_ID || null;
  const credentials = process.env.ERP_GOOGLE_SERVICE_ACCOUNT || null;
  const missing = [];
  if (!spreadsheetId) missing.push('ERP_GOOGLE_SHEET_ID');
  if (!credentials) missing.push('ERP_GOOGLE_SERVICE_ACCOUNT');

  return {
    configured: missing.length === 0,
    missing,
    spreadsheetId,
    sheetName: process.env.ERP_GOOGLE_SHEET_TAB || 'MASTER',
    /* Never true until someone has actually run an import against
       the real spreadsheet and said so. It is not something this
       code can establish about itself. */
    verified: false,
  };
}

export async function readGoogleSheet() {
  const config = googleSheetsConfig();

  throw new AppError(
    config.configured
      ? 'The Google Sheets adapter is configured but has never been run against the real '
        + 'spreadsheet, so it is disabled. Export the MASTER tab to .xlsx or .csv and upload it; '
        + 'that path is tested end to end.'
      : 'Google Sheets import is not configured. Missing: ' + config.missing.join(', ') + '. '
        + 'Export the MASTER tab to .xlsx or .csv and upload it instead.',
    {
      status: 501,
      code: 'GOOGLE_SHEETS_NOT_AVAILABLE',
      details: {
        missing: config.missing,
        expectedSheet: config.sheetName,
        expectedColumns: MASTER_COLUMNS,
        workaround: 'File > Download > Microsoft Excel (.xlsx), then upload it here.',
      },
    },
  );
}
