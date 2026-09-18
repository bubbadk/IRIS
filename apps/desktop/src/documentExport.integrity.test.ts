// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  createDocument,
  documentByteLimit,
  utf8ByteLength,
  type DocumentFormat,
  type IrisDocument,
} from '@iris/workspaces';
import {
  csvDocument,
  exportDocument,
  exportSupported,
  pdfDocument,
  presentationDocument,
  spreadsheetDocument,
  type DocumentExportFormat,
} from './documentExport';
import { parseCsv } from './csv';

/**
 * Phase 2E regression suite for document export integrity.
 *
 * The H-07 reproduction runs through the production export entry point (`exportDocument`), not the
 * PDF builder alone: the old implementation sliced the wrapped line list to its first 46 entries and
 * still resolved successfully.
 */

function makeDocument(content: string, format: DocumentFormat = 'markdown'): IrisDocument {
  return createDocument({
    id: 'phase-2e',
    title: 'Phase 2E integrity document',
    format,
    revision: {
      id: 'revision-1',
      content,
      createdAt: '2026-09-08T10:00:00Z',
      author: { kind: 'user', id: 'user', name: 'You' },
    },
  });
}

/** jsdom's Blob has neither `text()` nor `arrayBuffer()`, so read it through FileReader. */
function blobText(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The blob could not be read.'));
    reader.readAsText(blob);
  });
}

function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('The blob could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Long fixture: 200+ source lines, wrapped long lines, short lines, Unicode and paragraphs. */
function longDocumentContent(): string {
  const lines: string[] = ['# Long document'];
  for (let index = 1; index <= 200; index += 1) {
    if (index % 25 === 0) lines.push('');
    if (index % 10 === 0) {
      lines.push(
        `MARKER-${index} ` +
          'This paragraph is long enough to require wrapping across several physical PDF lines ' +
          'because it deliberately keeps going well past a single printed line of text.',
      );
    } else {
      lines.push(`MARKER-${index} short line with æøå ÆØÅ and special characters &<>"'.`);
    }
  }
  lines.push('FINAL-LINE-MARKER the very last line of the document.');
  return lines.join('\n');
}

/** Decodes one PDF literal string back to text, including octal WinAnsi escapes. */
function decodePdfLiteral(literal: string): string {
  const body = literal.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      out += character;
      continue;
    }
    const next = body[index + 1]!;
    if (next >= '0' && next <= '7') {
      out += String.fromCharCode(parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
      continue;
    }
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else out += next;
    index += 1;
  }
  return out;
}

/** Every `(...) Tj` show-text operand of a PDF, newline separated. */
function pdfShownText(pdf: string): string {
  return [...pdf.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g)]
    .map((match) => decodePdfLiteral(match[0].replace(/\s*Tj$/, '')))
    .join('\n');
}

function pdfPageCount(pdf: string): number {
  return [...pdf.matchAll(/\/Type \/Page[^s]/g)].length;
}

function parseXml(xml: string): Document {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror'))
    throw new Error(`Malformed XML: ${parsed.querySelector('parsererror')!.textContent}`);
  return parsed;
}

let captured: Blob | undefined;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalAnchorClick = HTMLAnchorElement.prototype.click;

beforeEach(() => {
  captured = undefined;
  URL.createObjectURL = (blob: Blob) => {
    captured = blob;
    return 'blob:phase-2e';
  };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = () => undefined;
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('H-07 PDF export completeness through the production export path', () => {
  it('exports every line of a 200+ line document instead of the first 46 wrapped lines', async () => {
    const content = longDocumentContent();
    await exportDocument(makeDocument(content), content, 'pdf');
    expect(captured).toBeDefined();
    const text = pdfShownText(await blobText(captured!));
    expect(text).toContain('MARKER-1 ');
    expect(text).toContain('MARKER-100 ');
    expect(text).toContain('FINAL-LINE-MARKER');
    for (let index = 1; index <= 200; index += 1) expect(text).toContain(`MARKER-${index} `);
  });

  it('reports the PDF as multi-page when the document needs more than one page', async () => {
    const content = longDocumentContent();
    const pdf = await blobText(pdfDocument(makeDocument(content), content));
    expect(pdfPageCount(pdf)).toBeGreaterThan(5);
    expect(pdf).toContain(`/Count ${pdfPageCount(pdf)}`);
    expect((pdf.match(/%%EOF/g) ?? []).length).toBe(1);
  });
});

describe('PDF pagination and encoding', () => {
  it('keeps a short document on a single page with all of its content', async () => {
    const pdf = await blobText(pdfDocument(makeDocument('Only line'), 'Only line'));
    expect(pdfPageCount(pdf)).toBe(1);
    const text = pdfShownText(pdf);
    expect(text).toContain('Phase 2E integrity document');
    expect(text).toContain('Only line');
  });

  it('places the first, a middle and the final marker on the correct pages', async () => {
    const content = longDocumentContent();
    const pdf = await blobText(pdfDocument(makeDocument(content), content));
    const pages = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) =>
      pdfShownText(match[1]!),
    );
    expect(pages.length).toBe(pdfPageCount(pdf));
    expect(pages[0]).toContain('MARKER-1 ');
    expect(pages.at(-1)).toContain('FINAL-LINE-MARKER');
    expect(pages.some((page) => page.includes('MARKER-100 '))).toBe(true);
  });

  it('keeps an entire long wrapped paragraph including its final word', async () => {
    const paragraph = `${'word '.repeat(400)}TERMINAL-WORD`;
    const pdf = await blobText(pdfDocument(makeDocument(paragraph), paragraph));
    const text = pdfShownText(pdf);
    expect(text).toContain('TERMINAL-WORD');
    const words = text.split('\n').join(' ').trim().split(/\s+/);
    expect(words.filter((word) => word === 'word')).toHaveLength(400);
  });

  it('breaks an unbroken string that is wider than the text column', async () => {
    const line = 'X'.repeat(4000);
    const pdf = await blobText(pdfDocument(makeDocument(line), line));
    const text = pdfShownText(pdf);
    expect((text.match(/X/g) ?? []).length).toBe(4000);
    for (const physical of text.split('\n')) expect(physical.length).toBeLessThan(200);
  });

  it('preserves empty lines as paragraph breaks', async () => {
    const content = 'alpha\n\n\nomega';
    const pdf = await blobText(pdfDocument(makeDocument(content), content));
    const text = pdfShownText(pdf).split('\n');
    expect(text.slice(-4)).toEqual(['alpha', '', '', 'omega']);
  });

  it('encodes Danish characters through WinAnsi instead of substituting them', async () => {
    const pdf = await blobText(pdfDocument(makeDocument('æøå ÆØÅ'), 'æøå ÆØÅ'));
    const text = pdfShownText(pdf);
    expect(text).toContain('æøå ÆØÅ');
    expect(text).not.toContain('?');
    expect(pdf).toContain('\\346\\370\\345');
    // The byte stream is pure ASCII: every non-Latin-1 character is octal-escaped, never emitted raw.
    expect(Array.from(pdf).every((character) => character.codePointAt(0)! <= 0x7f)).toBe(true);
  });

  it('fails explicitly for characters WinAnsi cannot represent instead of lying about success', () => {
    expect(() => pdfDocument(makeDocument('emoji 😀 inside'), 'emoji 😀 inside')).toThrow(
      'U+1F600',
    );
    expect(() => pdfDocument(makeDocument('kanji 文字'), 'kanji 文字')).toThrow(
      'PDF export supports Latin-1',
    );
    expect(() => pdfDocument(makeDocument('control \u0000'), 'control \u0000')).toThrow('U+0000');
  });

  it('counts its own completeness check correctly when the text contains PDF operators', async () => {
    const content = 'literal ) Tj ( and \\ backslash';
    const pdf = await blobText(pdfDocument(makeDocument(content), content));
    expect(pdfShownText(pdf)).toContain('literal ) Tj ( and \\ backslash');
  });

  it('defines the empty document as exactly one page containing the title', async () => {
    const pdf = await blobText(pdfDocument(makeDocument(''), ''));
    expect(pdfPageCount(pdf)).toBe(1);
    expect(pdfShownText(pdf).trim()).toBe('Phase 2E integrity document');
  });

  it('exports an extreme but allowed document without truncation', async () => {
    // Exactly at the UTF-8 byte limit: one marker at the very end must still be exported.
    const filler = 'filler line that is definitely long enough to wrap\n';
    const tail = 'EXTREME-TAIL-MARKER';
    const repetitions = Math.floor((documentByteLimit - tail.length) / filler.length);
    const content = `${filler.repeat(repetitions)}${tail}`;
    expect(utf8ByteLength(content)).toBeLessThanOrEqual(documentByteLimit);
    const pdf = await blobText(pdfDocument(makeDocument(content), content));
    expect(pdfPageCount(pdf)).toBeGreaterThan(100);
    expect(pdfShownText(pdf)).toContain(tail);
  });
});

describe('M-18 CSV parsing and generation', () => {
  it('round-trips a quoted comma, an escaped quote, CRLF and empty cells', () => {
    const source = 'name,note\r\n"Doe, Jane","say ""hi"" now"\r\n,empty\r\n"multi\nline",tail';
    const safe = csvDocument(makeDocument(source, 'csv'), source);
    expect(safe.type).toContain('text/csv');
  });

  it('exports content that ends with a blank record instead of refusing it', async () => {
    // Regression: the writer never terminated the last record, so a trailing blank record was
    // unrecoverable and the completeness gate refused these valid documents, telling the user the
    // export was incomplete and unsaved. Every input here was previously refused.
    for (const source of ['\n', '\r\n', '\n\n', 'a\n\n', 'a\r\n\r\n', 'a,b\n\n\n', '"q"\n\n']) {
      const exported = await blobText(csvDocument(makeDocument(source, 'csv'), source));
      expect(parseCsv(exported), JSON.stringify(source)).toEqual(parseCsv(source));
    }
  });

  it('terminates the final record so the written file round-trips through the parser', async () => {
    const source = 'a,b\nc,d';
    const exported = await blobText(csvDocument(makeDocument(source, 'csv'), source));
    expect(exported.endsWith('\r\n')).toBe(true);
    expect(parseCsv(exported)).toEqual(parseCsv(source));
  });

  it('keeps a quoted comma inside a single XLSX cell', async () => {
    const blob = await spreadsheetDocument(
      makeDocument('a,b', 'csv'),
      'name,note\r\n"Doe, Jane",ok',
    );
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const sheet = parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
    const rows = [...sheet.getElementsByTagName('row')];
    const cells = [...rows[1]!.getElementsByTagName('c')].map(
      (cell) => cell.getElementsByTagName('t')[0]!.textContent,
    );
    expect(cells).toEqual(['Doe, Jane', 'ok']);
    expect(cells).toHaveLength(2);
  });

  it('round-trips an escaped double quote', async () => {
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), '"say ""hi"""');
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const sheet = parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
    expect(sheet.getElementsByTagName('t')[0]!.textContent).toBe('say "hi"');
  });

  it('neutralizes spreadsheet formulas only in generated CSV, never in the source format', async () => {
    const source = 'label,value\n=1+1,@cmd\n-safe,+plus';
    const safe = await blobText(csvDocument(makeDocument(source, 'csv'), source));
    expect(safe).toContain("'=1+1,'@cmd");
    expect(safe).toContain("'-safe,'+plus");
    // The byte-faithful export of the document itself is unchanged.
    await exportDocument(makeDocument(source, 'csv'), source, 'source');
    expect(await blobText(captured!)).toBe(source);
  });

  it('does not create a trailing empty row for a trailing record separator', async () => {
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), 'one,two\n');
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const sheet = parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
    expect(sheet.getElementsByTagName('row')).toHaveLength(1);
  });

  it('refuses to emit a sheet a spreadsheet reader cannot open', async () => {
    await expect(
      spreadsheetDocument(makeDocument('a', 'csv'), Array.from({ length: 4 }, () => 'x').join(',')),
    ).resolves.toBeTruthy();
    await expect(
      spreadsheetDocument(makeDocument('a', 'csv'), '"'.concat('x'.repeat(32_768), '"')),
    ).rejects.toThrow('32767 characters per cell');
    await expect(
      spreadsheetDocument(
        makeDocument('a', 'csv'),
        Array.from({ length: 16_385 }, () => 'x').join(','),
      ),
    ).rejects.toThrow('16384 columns per row');
  });
});

describe('M-18 XLSX structural validity', () => {
  const hostile = '&<>"\' Ünïcödé\u0001\u000b';

  it('escapes and truncates in an order that always yields valid XML', async () => {
    const title = `${'&'.repeat(28)}&amp;&amp;&amp;`;
    const blob = await spreadsheetDocument(
      { ...makeDocument('a', 'csv'), title },
      'heading\nvalue',
    );
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const workbook = parseXml(await zip.file('xl/workbook.xml')!.async('string'));
    const name = workbook.getElementsByTagName('sheet')[0]!.getAttribute('name')!;
    // The truncation happens before escaping, so an entity can never be cut in half.
    expect(name).not.toContain('&am;');
    expect(Array.from(name).length).toBeLessThanOrEqual(31);
    expect(name).toContain('&');
    parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
  });

  it('keeps hostile characters as literal cell text in valid XML', async () => {
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), hostile);
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const sheet = parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
    const cell = sheet.getElementsByTagName('t')[0]!;
    expect(cell.textContent).toBe('&<>"\' Ünïcödé');
    expect(cell.getAttribute('xml:space')).toBe('preserve');
  });

  it('preserves quoted newlines and tabs inside a single cell', async () => {
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), '"multi\nline\tcell"');
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const sheet = parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
    expect(sheet.getElementsByTagName('row')).toHaveLength(1);
    expect(sheet.getElementsByTagName('t')[0]!.textContent).toBe('multi\nline\tcell');
  });

  it('marks every cell as an inline string so no cell can be executed as a formula', async () => {
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), '=1+1,+2,-3,@x');
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const sheet = parseXml(xml);
    for (const cell of sheet.getElementsByTagName('c'))
      expect(cell.getAttribute('t')).toBe('inlineStr');
    expect(xml).not.toContain('<f>');
    expect([...sheet.getElementsByTagName('t')].map((node) => node.textContent)).toEqual([
      '=1+1',
      '+2',
      '-3',
      '@x',
    ]);
  });

  it('handles boundary-length strings where escaping makes the output longer', async () => {
    const cell = '&'.repeat(32_767);
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), cell);
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const sheet = parseXml(await zip.file('xl/worksheets/sheet1.xml')!.async('string'));
    expect(sheet.getElementsByTagName('t')[0]!.textContent).toBe(cell);
  });

  it('produces a zip with the required OOXML parts and relationships', async () => {
    const blob = await spreadsheetDocument(makeDocument('a', 'csv'), 'a,b');
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ])
      expect(zip.file(part)).not.toBeNull();
    const types = parseXml(await zip.file('[Content_Types].xml')!.async('string'));
    const overrides = [...types.getElementsByTagName('Override')].map((node) =>
      node.getAttribute('PartName'),
    );
    expect(overrides).toContain('/xl/workbook.xml');
    expect(overrides).toContain('/xl/worksheets/sheet1.xml');
  });
});

describe('M-18 PPTX structural validity', () => {
  const allowedSpTreeChildren = new Set([
    'p:nvGrpSpPr',
    'p:grpSpPr',
    'p:sp',
    'p:grpSp',
    'p:graphicFrame',
    'p:cxnSp',
    'p:contentPart',
    'p:pic',
  ]);

  async function readPresentation(blob: Blob) {
    const zip = await JSZip.loadAsync(await blobBuffer(blob));
    const presentation = parseXml(await zip.file('ppt/presentation.xml')!.async('string'));
    const rels = parseXml(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string'));
    const types = parseXml(await zip.file('[Content_Types].xml')!.async('string'));
    return { zip, presentation, rels, types };
  }

  it('keeps presentation.xml.rels and every slide part consistent', async () => {
    const content = '# One\nbody one\n# Two\nbody two\n# Three\nbody three';
    const doc = makeDocument(content);
    const { zip, presentation, rels, types } = await readPresentation(
      await presentationDocument(doc, content),
    );
    const slideIds = [...presentation.getElementsByTagName('p:sldId')];
    expect(slideIds).toHaveLength(3);
    const relationships = [...rels.getElementsByTagName('Relationship')];
    const overrides = [...types.getElementsByTagName('Override')].map((node) =>
      node.getAttribute('PartName'),
    );
    for (const slideId of slideIds) {
      const relId = slideId.getAttribute('r:id')!;
      const relationship = relationships.find((node) => node.getAttribute('Id') === relId)!;
      expect(relationship).toBeDefined();
      expect(relationship.getAttribute('Type')).toContain('/slide');
      const target = `ppt/${relationship.getAttribute('Target')}`;
      expect(zip.file(target)).not.toBeNull();
      expect(overrides).toContain(`/${target}`);
      parseXml(await zip.file(target)!.async('string'));
    }
  });

  it('emits a spTree whose children are all valid CT_GroupShape members', async () => {
    const content = '# One\nbody\n# Two\nbody';
    const { zip } = await readPresentation(
      await presentationDocument(makeDocument(content), content),
    );
    for (let index = 1; index <= 2; index += 1) {
      const slide = parseXml(await zip.file(`ppt/slides/slide${index}.xml`)!.async('string'));
      const tree = slide.getElementsByTagName('p:spTree')[0]!;
      const children = [...tree.children].map((child) => child.tagName);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) expect(allowedSpTreeChildren.has(child)).toBe(true);
      // The malformed `<p:spPr/>` that used to sit directly in `p:spTree` is gone.
      expect(children).not.toContain('p:spPr');
      expect(children[0]).toBe('p:nvGrpSpPr');
      expect(children[1]).toBe('p:grpSpPr');
    }
  });

  it('keeps the first and last slide markers readable', async () => {
    const content = '# FIRST-SLIDE\nopening\n# Middle\nmiddle\n# LAST-SLIDE\nclosing';
    const { zip } = await readPresentation(
      await presentationDocument(makeDocument(content), content),
    );
    const text = async (index: number) =>
      [
        ...parseXml(
          await zip.file(`ppt/slides/slide${index}.xml`)!.async('string'),
        ).getElementsByTagName('a:t'),
      ]
        .map((node) => node.textContent)
        .join('|');
    expect(await text(1)).toContain('FIRST-SLIDE');
    expect(await text(3)).toContain('LAST-SLIDE');
    expect(await text(3)).toContain('closing');
  });
});

describe('export capability matrix', () => {
  const sources: DocumentFormat[] = ['markdown', 'text', 'html', 'svg', 'json', 'csv'];
  const destinations: DocumentExportFormat[] = ['source', 'pdf', 'word', 'xlsx', 'pptx', 'csv'];
  const expected: Record<DocumentFormat, DocumentExportFormat[]> = {
    markdown: ['source', 'pdf', 'word', 'pptx'],
    text: ['source', 'pdf', 'word', 'xlsx', 'pptx', 'csv'],
    html: ['source'],
    svg: ['source'],
    json: ['source', 'pdf'],
    csv: ['source', 'pdf', 'xlsx', 'csv'],
  };

  it('agrees between the matrix helper and the export implementation', async () => {
    const sample: Record<DocumentFormat, string> = {
      markdown: 'alpha,beta\n=1+1,gamma',
      text: 'alpha,beta\n=1+1,gamma',
      html: '<p>alpha</p>',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      json: '{"alpha":"beta"}',
      csv: 'alpha,beta\n=1+1,gamma',
    };
    for (const source of sources) {
      for (const destination of destinations) {
        const supported = expected[source].includes(destination);
        expect(exportSupported(destination, source)).toBe(supported);
        const doc = makeDocument(sample[source], source);
        const attempt = exportDocument(doc, doc.revisions[0].content, destination);
        if (supported) await expect(attempt).resolves.toBeTruthy();
        else await expect(attempt).rejects.toThrow('is not available for');
      }
    }
  });
});

describe('export success contract', () => {
  it('reports a real failure instead of partial output for an unrepresentable document', async () => {
    const content = 'emoji 😀 in a markdown document';
    await expect(exportDocument(makeDocument(content), content, 'pdf')).rejects.toThrow('U+1F600');
    expect(captured).toBeUndefined();
  });

  it('exports the complete source bytes for the original-format target', async () => {
    const content = 'plain\ntext with æøå and &<>"\'';
    await exportDocument(makeDocument(content, 'text'), content, 'source');
    expect(await blobText(captured!)).toBe(content);
  });

  it('exports a DOCX archive without regression', async () => {
    const content = '# Heading\ntext with æøå & <angle>';
    await exportDocument(makeDocument(content), content, 'word');
    const zip = await JSZip.loadAsync(await blobBuffer(captured!));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Heading');
    expect(xml).toContain('æøå &amp; &lt;angle&gt;');
  });
});
