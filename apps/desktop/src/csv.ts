/**
 * RFC 4180-style CSV parsing and generation for document export.
 *
 * The previous export path split records on `String.split(',')`, which is not CSV: it could not
 * represent a quoted comma, an escaped quote, or a multiline cell. This module is the single CSV
 * implementation used by the document export pipeline.
 */

const formulaTriggers = ['=', '+', '-', '@', '\t', '\r'] as const;

/**
 * Spreadsheet applications execute a cell whose text begins with `=`, `+`, `-` or `@`, even when the
 * value came from a CSV file. Generated CSV is meant for spreadsheet consumption, so a leading
 * apostrophe is prepended to such cells. This is deliberately a lossy, opt-in transformation: the
 * byte-faithful "export original format" path never rewrites the user's own document content.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  return formulaTriggers.some((trigger) => value.startsWith(trigger)) ? `'${value}` : value;
}

/** Parses CSV text into rows of cells. Accepts LF, CRLF and CR record separators. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let pending = false;
  let index = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    rows.push(row);
    row = [];
    pending = false;
  };
  while (index < text.length) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"' && field === '') {
      quoted = true;
      pending = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      pending = true;
      endField();
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      index += 1;
      endRecord();
      continue;
    }
    field += character;
    pending = true;
    index += 1;
  }
  if (pending) endRecord();
  return rows;
}

function needsQuotes(value: string): boolean {
  return (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    /^\s|\s$/.test(value)
  );
}

/** Serializes one cell using RFC 4180 quoting. */
export function csvCell(value: string): string {
  return needsQuotes(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serializes rows to RFC 4180 CSV text terminated with CRLF records. */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
