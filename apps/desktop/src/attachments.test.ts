import { describe, expect, it } from 'vitest';
import { classifyAttachment, formatTextAttachment, maxTextAttachmentChars } from './attachments';

describe('classifyAttachment', () => {
  it('classifies by MIME type first', () => {
    expect(classifyAttachment({ name: 'screenshot.png', type: 'image/png' })).toBe('image');
    expect(classifyAttachment({ name: 'notes.md', type: 'text/markdown' })).toBe('text');
    expect(classifyAttachment({ name: 'data.json', type: 'application/json' })).toBe('text');
  });

  it('falls back to a known text extension when the browser leaves type blank', () => {
    expect(classifyAttachment({ name: 'main.rs', type: '' })).toBe('text');
    expect(classifyAttachment({ name: 'config.yaml', type: '' })).toBe('text');
  });

  it('treats an extensionless, untyped file as text on a best-effort basis', () => {
    expect(classifyAttachment({ name: 'README', type: '' })).toBe('text');
  });

  it('rejects a binary format IRIS cannot read as text', () => {
    expect(classifyAttachment({ name: 'report.pdf', type: 'application/pdf' })).toBe('unsupported');
    expect(classifyAttachment({ name: 'archive.zip', type: 'application/zip' })).toBe('unsupported');
  });
});

describe('formatTextAttachment', () => {
  it('wraps the file content in a labeled fence', () => {
    expect(formatTextAttachment('notes.md', 'Hello world')).toBe(
      'Attached file: notes.md\n```\nHello world\n```',
    );
  });

  it('truncates oversized text with an honest, visible note instead of silently', () => {
    const content = 'a'.repeat(maxTextAttachmentChars + 500);
    const result = formatTextAttachment('big.log', content);
    expect(result).toContain(`…truncated — showing the first ${maxTextAttachmentChars.toLocaleString()} characters of big.log`);
    expect(result.length).toBeLessThan(content.length + 200);
  });

  it('leaves content under the cap untouched', () => {
    const content = 'short content';
    expect(formatTextAttachment('a.txt', content)).not.toContain('truncated');
  });
});
