import { documentFilename, type DocumentFormat, type IrisDocument } from '@iris/workspaces';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseCsv, serializeCsv, neutralizeSpreadsheetFormula } from './csv';

/**
 * The single capability matrix for document export. A conversion that cannot faithfully represent
 * the source document is refused by the export implementation itself; the user interface merely
 * mirrors this matrix so it never offers an operation the backend would reject.
 *
 * | Source   | PDF | DOCX | XLSX | PPTX | CSV |
 * | -------- | --- | ---- | ---- | ---- | --- |
 * | markdown | yes | yes  | no   | yes  | no  |
 * | text     | yes | yes  | yes  | yes  | yes |
 * | html     | no  | no   | no   | no   | no  |
 * | svg      | no  | no   | no   | no   | no  |
 * | json     | yes | no   | no   | no   | no  |
 * | csv      | yes | no   | yes  | no   | yes |
 */
export type DocumentExportFormat = 'source' | 'word' | 'pdf' | 'xlsx' | 'pptx' | 'csv';

const conversionSupport: Record<
  Exclude<DocumentExportFormat, 'source'>,
  readonly DocumentFormat[]
> = {
  word: ['markdown', 'text'],
  pdf: ['markdown', 'text', 'csv', 'json'],
  xlsx: ['csv', 'text'],
  pptx: ['markdown', 'text'],
  csv: ['csv', 'text'],
};

const conversionLabels: Record<Exclude<DocumentExportFormat, 'source'>, string> = {
  word: 'Word',
  pdf: 'PDF',
  xlsx: 'XLSX',
  pptx: 'Slides',
  csv: 'CSV',
};

export function exportSupported(
  format: DocumentExportFormat,
  source: DocumentFormat | undefined,
): boolean {
  if (format === 'source') return true;
  return source !== undefined && conversionSupport[format].includes(source);
}

export function assertExportSupported(format: DocumentExportFormat, source: DocumentFormat): void {
  if (exportSupported(format, source)) return;
  if (format === 'source') return;
  throw new Error(
    `${conversionLabels[format]} export is not available for ${source} documents. ` +
      `Supported sources: ${conversionSupport[format].join(', ')}.`,
  );
}

/** XML 1.0 forbids most C0 controls, the surrogate range and U+FFFE/U+FFFF. */
function xmlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code !== 0xfffe && code !== 0xffff)
      );
    })
    .join('');
}

function xmlText(value: string): string {
  return xmlCharacters(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlAttribute(value: string): string {
  return xmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function wordDocument(doc: IrisDocument, content: string): Promise<Blob> {
  if (doc.format !== 'markdown' && doc.format !== 'text')
    throw new Error('Word export is available for Markdown and text documents.');
  const { Document, Paragraph, TextRun, HeadingLevel, Packer } = await import('docx');
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  let code = false;
  const children = content.split('\n').map((line) => {
    if (doc.format === 'markdown' && line.startsWith('```')) {
      code = !code;
      return new Paragraph('');
    }
    const heading = !code && doc.format === 'markdown' ? /^(#{1,3})\s+(.+)$/.exec(line) : null;
    if (heading) return new Paragraph({ text: heading[2], heading: levels[heading[1].length - 1] });
    const bullet = !code && doc.format === 'markdown' ? /^\s*[-*+]\s+(.+)$/.exec(line) : null;
    return new Paragraph({
      children: [
        new TextRun({ text: bullet ? bullet[1] : line, ...(code ? { font: 'Courier New' } : {}) }),
      ],
      ...(bullet ? { bullet: { level: 0 } } : {}),
      spacing: { after: 120 },
    });
  });
  return Packer.toBlob(
    new Document({
      title: doc.title,
      creator: 'IRIS',
      sections: [{ children }],
      styles: {
        default: {
          document: { run: { font: 'Calibri', size: 22, color: '000000' } },
          heading1: { run: { color: '000000', bold: true, size: 32 } },
          heading2: { run: { color: '000000', bold: true, size: 28 } },
          heading3: { run: { color: '000000', bold: true, size: 24 } },
        },
      },
    }),
  );
}

/* -------------------------------------------------------------------------------------------- */
/* PDF                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** Page geometry for US Letter with 1 inch margins and a single Helvetica text column. */
const PDF_PAGE_WIDTH = 612;
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN = 72;
const PDF_BODY_SIZE = 11;
const PDF_TITLE_SIZE = 16;
const PDF_BODY_LEADING = 15;
const PDF_TITLE_LEADING = 30;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
const PDF_TOP = PDF_PAGE_HEIGHT - PDF_MARGIN;
const PDF_BOTTOM = PDF_MARGIN;

/** Helvetica AFM advance widths in 1/1000 em for U+0020..U+007E. */
const helveticaAsciiWidths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Helvetica AFM advance widths for the WinAnsi bytes 0xA0..0xFF. */
const helveticaLatin1Widths = [
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333,
  333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667,
  1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778,
  722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556,
  278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556,
  500,
];

/** WinAnsi codes for the printable characters that Latin-1 does not cover. */
const winAnsiSpecialCodes = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

const winAnsiWidths = new Map<number, number>([
  [0x20ac, 556],
  [0x201a, 222],
  [0x0192, 556],
  [0x201e, 333],
  [0x2026, 1000],
  [0x2020, 556],
  [0x2021, 556],
  [0x02c6, 333],
  [0x2030, 1000],
  [0x0160, 667],
  [0x2039, 333],
  [0x0152, 1000],
  [0x017d, 611],
  [0x2018, 222],
  [0x2019, 222],
  [0x201c, 333],
  [0x201d, 333],
  [0x2022, 350],
  [0x2013, 556],
  [0x2014, 1000],
  [0x02dc, 333],
  [0x2122, 1000],
  [0x0161, 500],
  [0x203a, 333],
  [0x0153, 944],
  [0x017e, 611],
  [0x0178, 667],
]);

/** Throws for a code point the standard WinAnsi Helvetica font set cannot represent. */
function winAnsiCode(codePoint: number): number {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  const special = winAnsiSpecialCodes.get(codePoint);
  if (special !== undefined) return special;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  const label = codePoint.toString(16).toUpperCase().padStart(4, '0');
  throw new Error(
    `PDF export supports Latin-1 (WinAnsi) text only, so U+${label} cannot be exported. ` +
      'Export this document as Word or text instead.',
  );
}

function advanceWidth(codePoint: number, size: number): number {
  const code = winAnsiCode(codePoint);
  const unit =
    code >= 0x20 && code <= 0x7e
      ? helveticaAsciiWidths[code - 0x20]!
      : code >= 0xa0
        ? helveticaLatin1Widths[code - 0xa0]!
        : (winAnsiWidths.get(codePoint) ?? 556);
  return (unit * size) / 1000;
}

function measure(text: string, size: number): number {
  let width = 0;
  for (const character of text) width += advanceWidth(character.codePointAt(0)!, size);
  return width;
}

function expandTabs(value: string): string {
  return value.replace(/\t/g, '    ');
}

/**
 * Greedy word wrap with a hard character break for tokens wider than the column. Every non-blank
 * character of the input survives in the output; only whitespace at a wrap point is dropped.
 */
function wrapText(text: string, size: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let current = '';
  let width = 0;
  const flush = () => {
    lines.push(current);
    current = '';
    width = 0;
  };
  for (const token of text.match(/\s+|\S+/g) ?? []) {
    const tokenWidth = measure(token, size);
    if (tokenWidth > PDF_CONTENT_WIDTH) {
      if (current) flush();
      for (const character of token) {
        const characterWidth = advanceWidth(character.codePointAt(0)!, size);
        if (current && width + characterWidth > PDF_CONTENT_WIDTH) flush();
        current += character;
        width += characterWidth;
      }
      continue;
    }
    if (current && width + tokenWidth > PDF_CONTENT_WIDTH) {
      if (/^\s+$/.test(token)) {
        flush();
        continue;
      }
      flush();
      current = token;
      width = tokenWidth;
      continue;
    }
    if (!current && /^\s+$/.test(token)) continue;
    current += token;
    width += tokenWidth;
  }
  flush();
  return lines;
}

interface PdfTextLine {
  font: 'F1' | 'F2';
  size: number;
  advance: number;
  text: string;
  baseline: number;
}

/** Lays the title and every wrapped body line onto as many pages as the content needs. */
function paginatePdf(title: string, content: string): PdfTextLine[][] {
  const lines: Omit<PdfTextLine, 'baseline'>[] = [];
  if (title)
    for (const text of wrapText(expandTabs(title), PDF_TITLE_SIZE))
      lines.push({ font: 'F2', size: PDF_TITLE_SIZE, advance: PDF_TITLE_LEADING, text });
  for (const source of content.split(/\r?\n/))
    for (const text of wrapText(expandTabs(source), PDF_BODY_SIZE))
      lines.push({ font: 'F1', size: PDF_BODY_SIZE, advance: PDF_BODY_LEADING, text });
  const pages: PdfTextLine[][] = [];
  let page: PdfTextLine[] = [];
  let baseline = PDF_TOP;
  for (const line of lines) {
    if (baseline < PDF_BOTTOM) {
      pages.push(page);
      page = [];
      baseline = PDF_TOP;
    }
    page.push({ ...line, baseline });
    baseline -= line.advance;
  }
  pages.push(page);
  return pages;
}

/** Escapes one visual line into a PDF literal string of WinAnsi bytes. */
function escapePdfText(text: string): string {
  let out = '';
  for (const character of text) {
    const byte = winAnsiCode(character.codePointAt(0)!);
    if (byte === 0x5c) out += '\\\\';
    else if (byte === 0x28) out += '\\(';
    else if (byte === 0x29) out += '\\)';
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += character;
  }
  return out;
}

function pageContentStream(page: readonly PdfTextLine[]): string {
  const parts = ['BT'];
  let activeFont = '';
  for (const line of page) {
    const font = `/${line.font} ${line.size}`;
    if (font !== activeFont) {
      parts.push(`${font} Tf`);
      activeFont = font;
    }
    parts.push(`1 0 0 1 ${PDF_MARGIN} ${line.baseline} Tm`);
    parts.push(`(${escapePdfText(line.text)}) Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

/**
 * A small self-contained PDF writer with real pagination. It preserves plain Latin-1 text and
 * deliberately has no rich layout. It never truncates: text the writer cannot represent raises an
 * error instead of being dropped or replaced.
 */
export function pdfDocument(doc: IrisDocument, content: string): Blob {
  assertExportSupported('pdf', doc.format);
  const pages = paginatePdf(doc.title.trim(), content);
  const streams = pages.map(pageContentStream);
  const objects: string[] = [];
  const reserve = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = reserve('');
  const pagesId = reserve('');
  const pageIds = streams.map(() => reserve(''));
  const regularFontId = reserve(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const boldFontId = reserve(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  const contentIds = streams.map((stream) =>
    reserve(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
  );
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
    `/Count ${pageIds.length} >>`;
  pageIds.forEach((id, index) => {
    objects[id - 1] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> ` +
      `/Contents ${contentIds[index]} 0 R >>`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    `${offsets.map((offset) => `${offset.toString().padStart(10, '0')} 00000 n `).join('\n')}` +
    `\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${start}\n%%EOF\n`;

  // The writer emits ASCII only, so string length is byte length and every offset above is exact.
  for (const character of pdf)
    if (character.codePointAt(0)! > 0x7f)
      throw new Error('The PDF export produced an unsupported character.');
  const expectedLines = pages.reduce((total, page) => total + page.length, 0);
  // One `(...) Tj` operator per visual line, each on its own line, so this counts exactly the lines
  // the layout produced. Escaped parentheses inside a literal cannot inflate the count.
  const emittedLines = pdf.match(/^\((?:\\.|[^\\()])*\) Tj$/gm)?.length ?? 0;
  if (emittedLines !== expectedLines)
    throw new Error('The PDF export is incomplete and has not been saved.');
  return new Blob([Uint8Array.from(pdf, (character) => character.charCodeAt(0))], {
    type: 'application/pdf',
  });
}

/* -------------------------------------------------------------------------------------------- */
/* XLSX                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** Excel's published workbook limits; exceeding them produces a file no reader will open. */
const xlsxRowLimit = 1_048_576;
const xlsxColumnLimit = 16_384;
const xlsxCellCharacterLimit = 32_767;

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** Sheet names may not exceed 31 characters, contain path punctuation or start/end with a quote. */
function sheetName(title: string): string {
  const sanitized = Array.from(title.replace(/[[\]:*?/\\]/g, '-'))
    .slice(0, 31)
    .join('')
    .replace(/^'+|'+$/g, '')
    .trim();
  return sanitized || 'Sheet1';
}

export async function spreadsheetDocument(doc: IrisDocument, content: string): Promise<Blob> {
  assertExportSupported('xlsx', doc.format);
  const rows = parseCsv(content);
  if (rows.length > xlsxRowLimit)
    throw new Error(`XLSX export supports at most ${xlsxRowLimit} rows.`);
  rows.forEach((row, index) => {
    if (row.length > xlsxColumnLimit)
      throw new Error(
        `XLSX export supports at most ${xlsxColumnLimit} columns per row; row ${index + 1} has ${row.length}.`,
      );
    for (const cell of row)
      if (Array.from(cell).length > xlsxCellCharacterLimit)
        throw new Error(
          `XLSX export supports at most ${xlsxCellCharacterLimit} characters per cell; row ${index + 1} exceeds it.`,
        );
  });
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const cells = rows
    .map(
      (row, index) =>
        `<row r="${index + 1}">${row
          .map(
            (cell, column) =>
              `<c r="${columnName(column)}${index + 1}" t="inlineStr"><is>` +
              `<t xml:space="preserve">${xmlText(cell)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('');
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlAttribute(sheetName(doc.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`,
  );
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* -------------------------------------------------------------------------------------------- */
/* PPTX                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * A small, standards-based presentation export. Markdown headings begin a new slide; text before
 * the first heading becomes the first slide body. It deliberately supports text only.
 */
export async function presentationDocument(doc: IrisDocument, content: string): Promise<Blob> {
  if (doc.format !== 'markdown' && doc.format !== 'text')
    throw new Error('Slide export is available for Markdown and text documents.');
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const xml = xmlText;
  type Slide = { title: string; lines: string[] };
  /**
   * Grouping is the intended content, so it is computed once and never filtered afterwards: a
   * heading-only group is meaningful content and must reach the package. Grouping carries no
   * "is body text present?" test, because that test is exactly what silently deleted a heading's
   * slide when the section had no body.
   */
  const slides: Slide[] = [];
  // The document title is not itself a heading: it only becomes a slide when the document carries
  // content before its first heading. `isHeading` marks a group that must reach the package even
  // when its body is empty, which is the behaviour the previous "body text must be present" test
  // silently removed.
  let current: Slide = { title: doc.title, lines: [] };
  let isHeading = false;
  const meaningful = (slide: Slide) => isHeading || slide.lines.some((value) => value.trim());
  for (const line of content.split(/\r?\n/)) {
    const heading = doc.format === 'markdown' ? /^#{1,3}\s+(.+)$/.exec(line) : null;
    if (heading) {
      if (meaningful(current)) slides.push(current);
      current = { title: heading[1]!, lines: [] };
      isHeading = true;
    } else {
      current.lines.push(line);
    }
  }
  if (meaningful(current)) slides.push(current);
  if (!slides.length && content.trim())
    slides.push({ title: doc.title || 'Untitled presentation', lines: [] });
  const paragraph = (value: string, size: number, bold = false) =>
    `<a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${xml(value)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${size}"/></a:p>`;
  const shape = (
    id: number,
    name: string,
    x: number,
    y: number,
    cx: number,
    cy: number,
    text: string,
    size: number,
    bold = false,
  ) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${text
      .split(/\r?\n/)
      .map((line) => paragraph(line || ' ', size, bold))
      .join('')}</p:txBody></p:sp>`;
  // A `p:spTree` may only contain `p:nvGrpSpPr`, `p:grpSpPr` and shape elements. The previous
  // generator emitted a stray `p:spPr` here, which is not a member of `CT_GroupShape`.
  const slideXml = (slide: Slide) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(2, 'Title', 685800, 457200, 10972800, 914400, slide.title, 3000, true)}${shape(3, 'Body', 914400, 1600200, 10515600, 4572000, slide.lines.join('\n'), 1800)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  );
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
  );
  slides.forEach((slide, index) => zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(slide)));
  // Semantic completeness gate. The grouping above is the intended deck, so the package must carry
  // exactly one slide part per intended group: export success may never report a deck that silently
  // lost content. This is a count of real emitted package parts, not a re-derivation of intent.
  const emittedParts = Object.keys(zip.files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length;
  if (emittedParts !== slides.length)
    throw new Error(
      'The slide export is incomplete and has not been saved. One or more slides were not written to the package.',
    );
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

/* -------------------------------------------------------------------------------------------- */
/* CSV                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * Generates spreadsheet-safe CSV from a CSV document. Every cell is round-tripped through the
 * RFC 4180 parser/writer and cells that a spreadsheet would execute as a formula are neutralized.
 */
export function csvDocument(doc: IrisDocument, content: string): Blob {
  assertExportSupported('csv', doc.format);
  const rows = parseCsv(content);
  const serialized = serializeCsv(rows);
  if (JSON.stringify(parseCsv(serialized)) !== JSON.stringify(rows))
    throw new Error('The CSV export is incomplete and has not been saved.');
  const safe = serializeCsv(rows.map((row) => row.map(neutralizeSpreadsheetFormula)));
  return new Blob([safe], { type: 'text/csv;charset=utf-8' });
}

/* -------------------------------------------------------------------------------------------- */
/* Export entry point                                                                            */
/* -------------------------------------------------------------------------------------------- */

export async function exportDocument(
  doc: IrisDocument,
  content: string,
  format: DocumentExportFormat = 'source',
): Promise<string | null> {
  assertExportSupported(format, doc.format);
  const filename = documentFilename(
    doc,
    format === 'source'
      ? undefined
      : format === 'word'
        ? 'docx'
        : format === 'pdf'
          ? 'pdf'
          : format === 'xlsx'
            ? 'xlsx'
            : format === 'pptx'
              ? 'pptx'
              : 'csv',
  );
  // Every branch either returns the complete bytes or throws; no format may report success for
  // partial output.
  const blob =
    format === 'word'
      ? await wordDocument(doc, content)
      : format === 'pdf'
        ? pdfDocument(doc, content)
        : format === 'xlsx'
          ? await spreadsheetDocument(doc, content)
          : format === 'pptx'
            ? await presentationDocument(doc, content)
            : format === 'csv'
              ? csvDocument(doc, content)
              : new Blob([content], { type: 'text/plain;charset=utf-8' });
  if (isTauri()) {
    // The native side owns the destination: it opens the Save dialog itself and hands back a
    // one-time capability token bound to the path the user actually chose. The renderer never
    // supplies a host path.
    const ticket = await invoke<{ token: string; path: string } | null>('begin_document_export', {
      suggestedName: filename,
      extension: filename.split('.').at(-1)!,
    });
    if (!ticket) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    await invoke<string>('save_document_export', { ticket: ticket.token, data: btoa(binary) });
    return ticket.path;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return filename;
}
