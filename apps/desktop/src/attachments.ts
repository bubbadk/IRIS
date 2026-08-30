/**
 * Chat composer attachments — "Add files or photos". Images become real vision content blocks on
 * the model request (see `ModelImage` in `@iris/providers`); everything else IRIS can read as text
 * is folded into the message body as a fenced, labeled block, so it works with every provider
 * unconditionally instead of only the ones that accept multimodal input.
 */

/** Comfortably under every major vision API's per-image request limit. */
export const maxImageBytes = 8 * 1024 * 1024;

/** Plenty for a pasted source file or log excerpt without ballooning the prompt. */
export const maxTextAttachmentChars = 200_000;

const textExtensions = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.jsonc',
  '.csv',
  '.tsv',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.rs',
  '.go',
  '.rb',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sql',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.html',
  '.css',
  '.xml',
  '.sh',
  '.bash',
  '.zsh',
]);

export type AttachmentKind = 'image' | 'text' | 'unsupported';

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  /** image only: base64, no `data:` prefix — goes straight onto a `ModelImage`. */
  base64Data?: string;
  /** image only: a `data:` URL for the composer thumbnail. */
  previewUrl?: string;
  /** text only: the ready-to-send fenced block, already labeled and length-capped. */
  textContent?: string;
  /** set when the file could not be attached; the UI shows this instead of a usable chip. */
  error?: string;
}

/** Classifies a file by MIME type first, then by extension for files a browser leaves untyped. */
export function classifyAttachment(file: { name: string; type: string }): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || file.type === 'application/json') return 'text';
  const dot = file.name.lastIndexOf('.');
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (textExtensions.has(extension)) return 'text';
  if (!file.type && !extension) return 'text'; // extensionless, untyped — most likely plain text
  return 'unsupported';
}

/** Wraps file text in a labeled fence, truncating with an honest note rather than silently. */
export function formatTextAttachment(name: string, content: string): string {
  const truncated = content.length > maxTextAttachmentChars;
  const body = truncated ? content.slice(0, maxTextAttachmentChars) : content;
  const note = truncated
    ? `\n[…truncated — showing the first ${maxTextAttachmentChars.toLocaleString()} characters of ${name}]`
    : '';
  return `Attached file: ${name}\n\`\`\`\n${body}${note}\n\`\`\``;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/** Reads a picked file into a composer-ready attachment. Never throws — failures land in `.error`. */
export async function readAttachmentFile(file: File): Promise<ComposerAttachment> {
  const id = `attachment-${crypto.randomUUID()}`;
  const base = { id, name: file.name, mimeType: file.type, size: file.size };
  const kind = classifyAttachment(file);

  if (kind === 'unsupported') {
    return {
      ...base,
      kind,
      error: `IRIS can't read "${file.name}" yet — attach an image or a text-based file.`,
    };
  }

  try {
    if (kind === 'image') {
      if (file.size > maxImageBytes) {
        return {
          ...base,
          kind,
          error: `"${file.name}" is larger than 8 MB — resize it before attaching.`,
        };
      }
      const dataUrl = await readFileAsDataUrl(file);
      const base64Data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      return {
        ...base,
        kind,
        mimeType: file.type || 'image/png',
        base64Data,
        previewUrl: dataUrl,
      };
    }
    const text = await file.text();
    return { ...base, kind, textContent: formatTextAttachment(file.name, text) };
  } catch (error) {
    return {
      ...base,
      kind,
      error: error instanceof Error ? error.message : `IRIS could not read "${file.name}".`,
    };
  }
}
