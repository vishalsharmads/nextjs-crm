import ExcelJS from 'exceljs';
import { AppError } from '../../lib/errors';
import { MAX_ROWS, parseCsv } from './import-export';

/** Columns read from a spreadsheet; anything wider is almost certainly not a list of records. */
const MAX_COLUMNS = 200;

/** An Excel workbook starts like any zip file. */
const isXlsx = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

/** One cell as the text an import column expects: dates as YYYY-MM-DD, formulas as their result. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
    return '';
  }
  return String(v).trim();
}

/** The first sheet of an Excel file, as a header row and data rows of text. */
async function parseXlsx(buf: Buffer): Promise<{ headers: string[]; rows: string[][] }> {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'This file could not be read as an Excel workbook (.xlsx)');
  }
  const sheet = book.worksheets[0];
  if (!sheet) throw new AppError('VALIDATION_FAILED', 'The workbook has no sheets');
  if (sheet.rowCount > MAX_ROWS + 1)
    throw new AppError('VALIDATION_FAILED', `Import up to ${MAX_ROWS.toLocaleString()} rows at a time`);
  const width = Math.min(sheet.columnCount, MAX_COLUMNS);
  const records: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = Array.from({ length: width }, (_, i) => cellText(row.getCell(i + 1).value));
    if (cells.some((c) => c !== '')) records.push(cells);
  });
  const [head, ...rows] = records;
  // Trailing empty header columns are dropped, and rows trimmed to match.
  let cols = head?.length ?? 0;
  while (cols > 0 && !head![cols - 1]) cols--;
  if (!head || !cols) throw new AppError('VALIDATION_FAILED', 'The first sheet has no header row');
  return { headers: head.slice(0, cols), rows: rows.map((r) => r.slice(0, cols)) };
}

/** A CSV or Excel (.xlsx) file as headers and rows; the same limits apply to both. */
export async function parseTable(buf: Buffer): Promise<{ headers: string[]; rows: string[][] }> {
  return isXlsx(buf) ? parseXlsx(buf) : parseCsv(buf);
}
