export const documentFormats = ['markdown', 'text', 'html', 'svg', 'json', 'csv'] as const;
export type DocumentFormat = (typeof documentFormats)[number];
export interface DocumentAuthor {
  kind: 'user' | 'agent';
  id: string;
  name: string;
  turnId?: string;
}
export interface DocumentRevision {
  id: string;
  number: number;
  content: string;
  createdAt: string;
  author: DocumentAuthor;
}
export interface IrisDocument {
  version: 1;
  id: string;
  title: string;
  format: DocumentFormat;
  revisions: DocumentRevision[];
}
export interface NewDocument {
  id: string;
  title: string;
  format: DocumentFormat;
  revision: Omit<DocumentRevision, 'number'>;
}

/**
 * The authoritative limits for durable documents. Document content stores bytes, so its limit is
 * measured in UTF-8 bytes; a title is human-readable text, so its limit is measured in Unicode
 * code points. Every entry point — tool schema description, tool runtime check and domain
 * validation — must agree on exactly these semantics.
 */
export const documentByteLimit = 262_144;
export const documentTitleLimit = 180;
export const documentRevisionLimit = 50;
/** Aggregate budget for the whole document store, independent of the per-revision limit. */
export const documentAggregateByteLimit = 8 * 1024 * 1024;
export const documentCountLimit = 200;

/** The one byte-length helper for document purposes. Never use `String.length` for storage limits. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Unicode-aware character count: code points, not UTF-16 code units. */
export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function requireDocumentTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The document title must be text.');
  const title = value.trim();
  if (!title) throw new Error('The document title is required.');
  if (unicodeLength(title) > documentTitleLimit)
    throw new Error(
      `The document title must be at most ${documentTitleLimit} characters (this title is ${unicodeLength(title)}).`,
    );
  return title;
}

export function requireDocumentContent(content: unknown, format: DocumentFormat): string {
  if (typeof content !== 'string') throw new Error('Document content must be text.');
  const bytes = utf8ByteLength(content);
  if (bytes > documentByteLimit)
    throw new Error(
      `Document content must be no larger than ${documentByteLimit} UTF-8 bytes (this content is ${bytes} bytes).`,
    );
  if (format === 'json') {
    try {
      JSON.parse(content);
    } catch {
      throw new Error('The document contains invalid JSON.');
    }
  }
  return content;
}

/** The total serialized size a set of documents occupies in durable storage. */
export function documentStoreByteSize(documents: readonly IrisDocument[]): number {
  return utf8ByteLength(JSON.stringify(documents));
}

export function validateDocument(value: unknown): value is IrisDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<IrisDocument>;
  if (
    doc.version !== 1 ||
    typeof doc.id !== 'string' ||
    !doc.id.trim() ||
    typeof doc.title !== 'string' ||
    !doc.title.trim() ||
    unicodeLength(doc.title) > documentTitleLimit ||
    !documentFormats.includes(doc.format as DocumentFormat) ||
    !Array.isArray(doc.revisions) ||
    !doc.revisions.length ||
    doc.revisions.length > documentRevisionLimit
  )
    return false;
  const ids = new Set<string>();
  for (const [index, revision] of doc.revisions.entries()) {
    if (
      !revision ||
      typeof revision.id !== 'string' ||
      !revision.id ||
      ids.has(revision.id) ||
      revision.number !== index + 1 ||
      typeof revision.createdAt !== 'string' ||
      Number.isNaN(Date.parse(revision.createdAt)) ||
      !revision.author ||
      !['user', 'agent'].includes(revision.author.kind) ||
      typeof revision.author.id !== 'string' ||
      !revision.author.id ||
      typeof revision.author.name !== 'string' ||
      !revision.author.name ||
      (revision.author.turnId !== undefined && typeof revision.author.turnId !== 'string')
    )
      return false;
    try {
      requireDocumentContent(revision.content, doc.format as DocumentFormat);
    } catch {
      return false;
    }
    ids.add(revision.id);
  }
  return true;
}

export function createDocument(input: NewDocument): IrisDocument {
  if (!documentFormats.includes(input.format))
    throw new Error('The document title, format, content or author is invalid.');
  const doc: IrisDocument = {
    version: 1,
    id: input.id,
    title: requireDocumentTitle(input.title),
    format: input.format,
    revisions: [
      {
        ...input.revision,
        content: requireDocumentContent(input.revision.content, input.format),
        number: 1,
      },
    ],
  };
  if (!validateDocument(doc))
    throw new Error('The document title, format, content or author is invalid.');
  return structuredClone(doc);
}

export function reviseDocument(
  doc: IrisDocument,
  expectedRevisionId: string,
  revision: Omit<DocumentRevision, 'number'>,
): IrisDocument {
  if (!validateDocument(doc)) throw new Error('The saved document is invalid.');
  if (doc.revisions.at(-1)!.id !== expectedRevisionId)
    throw new Error('This document has a newer revision. Reload it before saving your changes.');
  requireDocumentContent(revision.content, doc.format);
  if (doc.revisions.at(-1)!.content === revision.content) return structuredClone(doc);
  if (doc.revisions.length >= documentRevisionLimit)
    throw new Error(
      `This document has reached ${documentRevisionLimit} revisions. Create a copy to continue; existing history is retained.`,
    );
  const next = {
    ...doc,
    revisions: [...doc.revisions, { ...revision, number: doc.revisions.length + 1 }],
  };
  if (!validateDocument(next)) throw new Error('The document revision is invalid.');
  return structuredClone(next);
}

export function documentFilename(
  doc: Pick<IrisDocument, 'title' | 'format'>,
  extension?: string,
): string {
  // Truncate by code points so a 100-character filename can never split a surrogate pair.
  const title =
    Array.from(
      doc.title
        .split('')
        .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
        .join('')
        .replace(/[<>:"/\\|?*]/g, '-')
        .replace(/^[. ]+|[. ]+$/g, ''),
    )
      .slice(0, 100)
      .join('') || 'document';
  return `${title}.${extension ?? { markdown: 'md', text: 'txt', html: 'html', svg: 'svg', json: 'json', csv: 'csv' }[doc.format]}`;
}
