// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { staticDocumentPreview } from './documentPreview';
describe('static document preview', () => {
  it('removes active content and navigation while preserving readable content and styles', () => {
    const html = staticDocumentPreview(
      `<html><head><style>h1 { color: red }</style><meta http-equiv="refresh" content="0;url=https://example.com"></head><body><h1 onclick="alert(1)">Report</h1><script>alert(1)</script><iframe srcdoc="danger"></iframe><form><input></form><a href="data:image/svg+xml,danger" ping="https://example.com">Link</a><img src="https://example.com/track" onerror="alert(1)"><svg><foreignObject>unsafe</foreignObject><animate attributeName="href"/><text>Diagram</text></svg></body></html>`,
    );
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.querySelector('script, iframe, form, foreignObject, animate')).toBeNull();
    expect(parsed.querySelector('[onclick], [onerror], [href], [ping], [src]')).toBeNull();
    expect(parsed.querySelector('h1')?.textContent).toBe('Report');
    expect(parsed.querySelector('text')?.textContent).toBe('Diagram');
    expect(parsed.querySelectorAll('meta')).toHaveLength(1);
    expect(parsed.querySelector('meta')?.getAttribute('content')).toContain("default-src 'none'");
    expect(html).toContain('h1 { color: red }');
  });
  it('allows embedded images but never inherited script privileges', () => {
    const html = staticDocumentPreview(
      '<img src="data:image/png;base64,AAAA"><svg onload="alert(1)"><use href="https://example.com/image.svg#x"/></svg>',
    );
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('href=');
  });
});
