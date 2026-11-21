import ExcelJS from 'exceljs';
import { MASTER_COLUMNS } from '../../server/import/mapping.mjs';

/* Builds .xlsx fixtures shaped exactly like the catalogue
   pipeline's MASTER tab — same columns, same order, same header
   row — so the tests exercise the real format rather than a
   convenient one. */

export function masterRow(overrides = {}) {
  const row = {};
  for (const column of MASTER_COLUMNS) row[column] = '';
  row['Status'] = 'ACTIVE';
  row['Application Source'] = 'EXTRACTION';
  row['AI Classification Status'] = 'NOT_CLASSIFIED';
  return { ...row, ...overrides };
}

export async function buildWorkbook(rows, { sheetName = 'MASTER' } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(MASTER_COLUMNS);
  for (const row of rows) sheet.addRow(MASTER_COLUMNS.map((c) => row[c] ?? ''));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
