import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createDocument } from '@iris/workspaces';
import {
  pdfDocument,
  presentationDocument,
  spreadsheetDocument,
  wordDocument,
} from './documentExport';
const doc = createDocument({
  id: 'test',
  title: 'Word export verification',
  format: 'markdown',
  revision: {
    id: 'revision',
    content:
      '# Export verification\nText with æ ø å & <characters>.\n## Checks\n- Saved content\n- Revision history\n```\n# Literal code\n```',
    createdAt: '2026-09-08T10:00:00Z',
    author: { kind: 'user', id: 'test', name: 'Test' },
  },
});
describe('real Word export', () => {
  it('produces a real PDF byte stream from saved text', async () => {
    const pdf = await pdfDocument(doc, 'A saved report.');
    const text = await pdf.text();
    expect(text).toContain('%PDF-1.4');
    expect(text).toContain('A saved report.');
    expect(text).toContain('%%EOF');
  });
  it('produces an XLSX archive with the saved comma-separated rows', async () => {
    const zip = await JSZip.loadAsync(
      await (
        await spreadsheetDocument(
          { ...doc, title: 'Plan "A"', format: 'csv' },
          'Name,Status\nIRIS,Ready',
        )
      ).arrayBuffer(),
    );
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('Ready');
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('Plan &quot;A&quot;');
  });
  it('refuses conversions the source format cannot faithfully represent', async () => {
    await expect(spreadsheetDocument(doc, 'Name,Status')).rejects.toThrow(
      'not available for markdown documents',
    );
    expect(() => pdfDocument({ ...doc, format: 'svg' }, '<svg/>')).toThrow(
      'not available for svg documents',
    );
    await expect(wordDocument({ ...doc, format: 'csv' }, 'a,b')).rejects.toThrow(
      'Markdown and text',
    );
  });
  it('produces a real PPTX archive with one slide per Markdown heading', async () => {
    const zip = await JSZip.loadAsync(
      await (
        await presentationDocument(
          doc,
          '# First slide\nOpening text\n## Second slide\nClosing text',
        )
      ).arrayBuffer(),
    );
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('sldIdLst');
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('First slide');
    expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('Closing text');
  });
  it('rejects slide export for formats with non-text semantics', async () => {
    await expect(
      presentationDocument({ ...doc, format: 'html' }, '<h1>Slides</h1>'),
    ).rejects.toThrow('Markdown and text');
  });
  it('produces a readable OOXML archive with headings, list definitions, Unicode and literal code', async () => {
    const blob = await wordDocument(doc, doc.revisions[0].content);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('æ ø å &amp; &lt;characters&gt;');
    expect(xml).toContain('w:numPr');
    expect(xml).toContain('# Literal code');
    expect(xml).not.toContain('```');
    expect(await zip.file('word/numbering.xml')!.async('string')).toContain('w:val="bullet"');
  });
  it('exports selected older content and keeps plain text markup literal', async () => {
    const zip = await JSZip.loadAsync(
      await (await wordDocument({ ...doc, format: 'text' }, '# Earlier content')).arrayBuffer(),
    );
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('# Earlier content');
    expect(xml).not.toContain('Saved content');
    expect(xml).not.toContain('w:val="Heading1"');
    await expect(wordDocument({ ...doc, format: 'html' }, '<h1>Report</h1>')).rejects.toThrow(
      'Markdown and text',
    );
  });
});
