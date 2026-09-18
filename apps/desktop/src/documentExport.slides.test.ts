// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createDocument, type DocumentFormat, type IrisDocument } from '@iris/workspaces';
import { exportDocument, presentationDocument } from './documentExport';

/**
 * Phase 2I.4 regression suite — PPTX semantic completeness.
 *
 * The defect this pins: `presentationDocument` buffered a slide per Markdown heading but flushed the
 * buffer only when the buffer's **body** had non-blank text. A heading whose section had no body
 * text was therefore discarded, while the export still reported success. A three-heading deck
 * produced one slide; a five-heading deck produced four.
 *
 * Every test below reads the real generated OOXML package (ZIP entries, `[Content_Types].xml`,
 * `ppt/presentation.xml` and `ppt/_rels/presentation.xml.rels`). The count gate inside the exporter
 * is exercised through the production entry point, so "reported success" and "wrote every slide"
 * are asserted together rather than separately.
 */

function makeDocument(
  content: string,
  format: DocumentFormat = 'markdown',
  title = 'Deck',
): IrisDocument {
  return createDocument({
    id: 'phase-2i4-slides',
    title,
    format,
    revision: {
      id: 'revision-1',
      content,
      createdAt: '2026-09-18T10:00:00Z',
      author: { kind: 'user', id: 'user', name: 'You' },
    },
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

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

type Package = {
  slideParts: string[];
  titles: string[];
  bodies: string[];
  sldIdRelIds: string[];
  relTargets: string[];
  overridePartNames: string[];
};

/** Reads the emitted package exactly as a consuming application would. */
async function readPackage(blob: Blob): Promise<Package> {
  const zip = await JSZip.loadAsync(await blobBuffer(blob));
  const slideParts = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => {
      const number = (name: string) => Number(/slide(\d+)\.xml$/.exec(name)![1]);
      return number(left) - number(right);
    });
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const types = await zip.file('[Content_Types].xml')!.async('string');
  const titles: string[] = [];
  const bodies: string[] = [];
  for (const part of slideParts) {
    const xml = await zip.file(part)!.async('string');
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => unescapeXml(match[1]!));
    // The first `<a:t>` belongs to the title shape; the remaining text is the body shape.
    titles.push(texts[0] ?? '');
    bodies.push(texts.slice(1).join('\n'));
  }
  return {
    slideParts,
    titles,
    bodies,
    sldIdRelIds: [...presentation.matchAll(/<p:sldId id="\d+" r:id="(rId\d+)"\/>/g)].map(
      (match) => match[1]!,
    ),
    relTargets: [...rels.matchAll(/Id="rId\d+"[^>]*Target="([^"]+)"/g)].map((match) => match[1]!),
    overridePartNames: [...types.matchAll(/PartName="(\/ppt\/slides\/slide\d+\.xml)"/g)].map(
      (match) => match[1]!,
    ),
  };
}

describe('PPTX semantic completeness', () => {
  it('emits one slide per heading even when a section has no body text', async () => {
    const content = ['# Alpha', '# Beta', '# Gamma'].join('\n');
    const { titles, slideParts } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    // Before the repair this was ["Gamma"] — a single slide for three intended headings.
    expect(titles).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(slideParts).toHaveLength(3);
  });

  it('keeps mid-deck heading-only sections instead of dropping them', async () => {
    const content = ['# First', 'body first', '# Middle', '# Last', 'body last'].join('\n');
    const { titles } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    // Before the repair this was ["First", "Last"] — the middle heading vanished and the deck was
    // reported as exported.
    expect(titles).toEqual(['First', 'Middle', 'Last']);
  });

  it('emits consecutive headings as consecutive slides without reordering', async () => {
    const content = ['# One', '# Two', '# Three', 'body three'].join('\n');
    const { titles } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    expect(titles).toEqual(['One', 'Two', 'Three']);
  });

  it('flushes the final heading when it carries no following body', async () => {
    const content = ['# One', 'body one', '# Trailing'].join('\n');
    const { titles, bodies } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    expect(titles).toEqual(['One', 'Trailing']);
    expect(bodies[0]).toBe('body one');
    // An empty body shape still carries its placeholder space, so the slide has no content lines.
    expect(bodies[1]!.trim()).toBe('');
  });

  it('produces a single heading-only slide for a single-heading document', async () => {
    const content = '# Only';
    const { titles, slideParts } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    expect(titles).toEqual(['Only']);
    expect(slideParts).toHaveLength(1);
  });

  it('treats whitespace-only section bodies as heading-only slides, not as content', async () => {
    const content = ['# One', '   ', '# Two', '', '# Three'].join('\n');
    const { titles, bodies } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    expect(titles).toEqual(['One', 'Two', 'Three']);
    // A whitespace-only body is not content, so the slide stays heading-only.
    expect(bodies.every((body) => body.trim() === '')).toBe(true);
  });

  it('never fabricates a slide for content the document does not contain', async () => {
    // A document that starts with a heading must not gain a leading title-only slide, and an empty
    // document must not gain a slide at all.
    const startsWithHeading = await readPackage(
      await presentationDocument(makeDocument('# Solo', 'markdown'), '# Solo'),
    );
    expect(startsWithHeading.titles).toEqual(['Solo']);

    const empty = await readPackage(await presentationDocument(makeDocument(''), ''));
    expect(empty.slideParts).toEqual([]);
    expect(empty.sldIdRelIds).toEqual([]);
  });

  it('keeps preamble text as the first slide before any heading boundary', async () => {
    const content = ['preamble', '# One', '# Two'].join('\n');
    const { titles, bodies } = await readPackage(
      await presentationDocument(makeDocument(content, 'markdown', 'Deck'), content),
    );
    expect(titles).toEqual(['Deck', 'One', 'Two']);
    expect(bodies[0]).toBe('preamble');
  });

  it('preserves Unicode headings and XML-escaping them without loss', async () => {
    const content = ['# Überschrift', '# 日本語の見出し', '# Ünïcödé & <angle>'].join('\n');
    const { titles } = await readPackage(
      await presentationDocument(makeDocument(content), content),
    );
    expect(titles).toEqual(['Überschrift', '日本語の見出し', 'Ünïcödé & <angle>']);
  });

  it('keeps text documents as a single slide (headings are Markdown-only boundaries)', async () => {
    const content = ['# not a heading here', 'second line'].join('\n');
    const { titles, slideParts } = await readPackage(
      await presentationDocument(makeDocument(content, 'text'), content),
    );
    expect(slideParts).toHaveLength(1);
    expect(titles).toEqual(['Deck']);
  });
});

describe('PPTX structural consistency after the completeness repair', () => {
  const structures: { name: string; content: string }[] = [
    { name: 'heading-only deck', content: ['# Alpha', '# Beta', '# Gamma'].join('\n') },
    { name: 'mixed deck', content: ['# One', 'body', '# Two', '# Three', 'body three'].join('\n') },
    { name: 'no headings', content: ['just body', 'more body'].join('\n') },
    { name: 'single heading', content: '# Only' },
  ];

  for (const structure of structures) {
    it(`keeps every slide part, content type, relationship and sldId consistent: ${structure.name}`, async () => {
      const pkg = await readPackage(
        await presentationDocument(makeDocument(structure.content), structure.content),
      );
      // One content-type override and one relationship per emitted slide part, in the same order.
      expect(pkg.overridePartNames).toEqual(pkg.slideParts.map((part) => `/${part}`));
      expect(pkg.relTargets).toEqual(
        pkg.slideParts.map((_, index) => `slides/slide${index + 1}.xml`),
      );
      expect(pkg.sldIdRelIds).toEqual(pkg.slideParts.map((_, index) => `rId${index + 1}`));
      expect(new Set(pkg.sldIdRelIds).size).toBe(pkg.sldIdRelIds.length);
      // A slide title is never duplicated, so later content cannot shift under the wrong title.
      expect(new Set(pkg.titles).size).toBe(pkg.titles.length);
    });
  }

  it('carries every intended slide through the production export entry point', async () => {
    // jsdom is not a Tauri runtime, so `exportDocument` takes the browser path: it renders the
    // bytes and hands them to an object URL. Capturing that blob exercises the real entry point
    // rather than the builder alone, so "reported success" and "wrote every slide" are asserted
    // together.
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let captured: Blob | undefined;
    URL.createObjectURL = (blob: Blob) => {
      captured = blob;
      return 'blob:phase-2i4';
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = () => undefined;
    try {
      const content = ['# Alpha', '# Beta', '# Gamma'].join('\n');
      await expect(exportDocument(makeDocument(content), content, 'pptx')).resolves.toBe(
        'Deck.pptx',
      );
      expect(captured).toBeDefined();
      const pkg = await readPackage(captured!);
      expect(pkg.titles).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(pkg.overridePartNames).toHaveLength(3);
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});
