import {
  documentByteLimit,
  documentFormats,
  documentRevisionLimit,
  documentTitleLimit,
  requireDocumentContent,
  requireDocumentTitle,
  type DocumentFormat,
} from '@iris/workspaces';
import type { RegisteredTool, ToolContext } from '@iris/tools';
import { documentRepository, notifyDocumentsChanged } from './documents';
function values(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Document tools require an object input.');
  return input as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}
/**
 * The authoritative content check. `maxLength` in the JSON Schema below counts characters and
 * cannot express a byte budget, so it is only a coarse upper bound: a payload can satisfy the
 * schema and still exceed the real UTF-8 limit. This runs the same byte rule the domain uses, so
 * the tool layer and the repository always agree on the same payload.
 */
function documentContent(content: unknown, format: DocumentFormat): string {
  return requireDocumentContent(content, format);
}
function documentTitle(title: unknown): string {
  return requireDocumentTitle(title);
}
function revision(content: unknown, context: ToolContext) {
  if (typeof content !== 'string') throw new Error('Document content must be text.');
  return {
    id: crypto.randomUUID(),
    content,
    createdAt: new Date().toISOString(),
    author: {
      kind: 'agent' as const,
      id: context.agentId,
      name: context.agentName,
      turnId: context.turnId,
    },
  };
}
export function createDocumentTools(): RegisteredTool[] {
  return [
    {
      id: 'documents.create',
      name: 'Create document',
      providerName: 'documents_create',
      risk: 'write',
      manualExecution: false,
      description:
        `Creates a durable document in the IRIS Documents window with real content and revision history. Supports Markdown, text, HTML, SVG, JSON and CSV. ` +
        `Content is limited to ${documentByteLimit} UTF-8 bytes (not characters) and the title to ${documentTitleLimit} characters. ` +
        `This saves inside IRIS; it does not export a file or verify correctness.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            maxLength: documentTitleLimit,
            description: `Maximum ${documentTitleLimit} characters.`,
          },
          format: { type: 'string', enum: [...documentFormats] },
          content: {
            type: 'string',
            // Coarse upper bound only: the authoritative limit is UTF-8 bytes and is enforced at
            // runtime, because JSON Schema `maxLength` counts characters, not bytes.
            maxLength: documentByteLimit,
            description:
              `Complete document text, at most ${documentByteLimit} UTF-8 bytes. ` +
              'Non-ASCII characters count as more than one byte each, so the byte limit can be reached before the character limit.',
          },
        },
        required: ['title', 'format', 'content'],
        additionalProperties: false,
      },
      async run(input, context) {
        const value = values(input);
        if (!documentFormats.includes(value.format as DocumentFormat))
          throw new Error('Unsupported document format.');
        const format = value.format as DocumentFormat;
        const doc = await documentRepository.create({
          id: crypto.randomUUID(),
          title: documentTitle(value.title),
          format,
          revision: revision(documentContent(value.content, format), context),
        });
        notifyDocumentsChanged();
        return {
          id: doc.id,
          title: doc.title,
          format: doc.format,
          revisionId: doc.revisions.at(-1)!.id,
          revision: 1,
          savedIn: 'IRIS Documents',
        };
      },
    },
    {
      id: 'documents.revise',
      name: 'Revise document',
      providerName: 'documents_revise',
      risk: 'write',
      manualExecution: false,
      description:
        `Saves a complete new document revision while retaining earlier revisions, up to ${documentRevisionLimit} revisions. ` +
        `Read the document first and pass its latest revisionId; stale revisions are refused. ` +
        `Content is limited to ${documentByteLimit} UTF-8 bytes (not characters).`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          expectedRevisionId: { type: 'string' },
          content: {
            type: 'string',
            maxLength: documentByteLimit,
            description:
              `Complete replacement text, at most ${documentByteLimit} UTF-8 bytes. ` +
              'Non-ASCII characters count as more than one byte each.',
          },
        },
        required: ['id', 'expectedRevisionId', 'content'],
        additionalProperties: false,
      },
      async run(input, context) {
        const value = values(input);
        const documentId = text(value.id, 'Document id');
        const expectedRevisionId = text(value.expectedRevisionId, 'Expected revision id');
        const existing = await documentRepository.get(documentId);
        if (!existing) throw new Error('The document is unavailable.');
        const doc = await documentRepository.revise(
          documentId,
          expectedRevisionId,
          revision(documentContent(value.content, existing.format), context),
        );
        notifyDocumentsChanged();
        return {
          id: doc.id,
          revisionId: doc.revisions.at(-1)!.id,
          revision: doc.revisions.at(-1)!.number,
          savedIn: 'IRIS Documents',
        };
      },
    },
    {
      id: 'documents.read',
      name: 'Read document',
      providerName: 'documents_read',
      risk: 'read',
      manualExecution: false,
      description:
        'Reads the latest saved document content and revision identity from IRIS Documents.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      async run(input) {
        const doc = await documentRepository.get(text(values(input).id, 'Document id'));
        if (!doc) throw new Error('The document is unavailable.');
        const saved = doc.revisions.at(-1)!;
        return {
          id: doc.id,
          title: doc.title,
          format: doc.format,
          revisionId: saved.id,
          revision: saved.number,
          content: saved.content,
          author: saved.author,
        };
      },
    },
    {
      id: 'documents.list',
      name: 'List documents',
      providerName: 'documents_list',
      risk: 'read',
      manualExecution: false,
      description: 'Lists real saved IRIS documents without returning their full content.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return (await documentRepository.list()).map((doc) => ({
          id: doc.id,
          title: doc.title,
          format: doc.format,
          revisionId: doc.revisions.at(-1)!.id,
          revision: doc.revisions.at(-1)!.number,
        }));
      },
    },
  ];
}
