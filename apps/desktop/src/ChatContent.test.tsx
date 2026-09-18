// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RichMessage } from './ChatContent';
function render(content: string) {
  const element = document.createElement('div');
  element.innerHTML = renderToStaticMarkup(<RichMessage content={content} />);
  return element;
}
it('renders headings, tables, lists, code and labelled citations without raw Markdown', () => {
  const view = render(
    '## Verified\n\n| Item | Status |\n| --- | --- |\n| File | Present |\n\n1. Inspect `file.txt`\n2. Read [the source](https://example.com)\n\n```text\n<untrusted>\n```',
  );
  expect(view.querySelector('h2')?.textContent).toBe('Verified');
  expect(view.querySelectorAll('tbody td')).toHaveLength(2);
  expect(view.querySelectorAll('ol li')).toHaveLength(2);
  expect(view.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  expect(view.querySelector('pre code')?.textContent).toContain('<untrusted>');
});
it('does not activate raw HTML, unsafe links or unsafe images from model text', () => {
  const view = render(
    '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![bad](data:image/svg+xml,bad)\n\n<iframe src="https://example.com"></iframe>',
  );
  expect(view.querySelector('script,iframe,img,a[href]')).toBeNull();
});
it('preserves naked generated-image previews and incomplete streamed Markdown', () => {
  expect(render('https://example.com/image.png').querySelector('img')?.src).toBe(
    'https://example.com/image.png',
  );
  expect(render('## Working\n\n**partial').textContent).toContain('partial');
});
