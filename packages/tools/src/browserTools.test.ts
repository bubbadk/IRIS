import { describe, expect, it } from 'vitest';
import {
  createAllBrowserTools,
  createBrowserNavigateTool,
  createBrowserVisionTool,
  requireHttpUrl,
} from './browserTools';

const context = { agentId: 'agent', agentName: 'Operator' };

const refuse = [
  'ftp://example.com/file',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,<h1>x</h1>',
  'chrome://settings',
  'about:blank',
  '//example.com/protocol-relative',
  '/relative/path',
  'example.com',
  'http://user:password@example.com/',
  'https://token@example.com/',
  '',
  '   ',
];

describe('browser tool URL contract', () => {
  it('accepts an explicit http or https address without credentials', () => {
    expect(requireHttpUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
    expect(requireHttpUrl('https://example.com/')).toBe('https://example.com/');
    expect(requireHttpUrl('  https://example.com/  ')).toBe('https://example.com/');
  });

  it('refuses every non-web scheme, relative reference and credential-carrying URL', () => {
    for (const url of refuse) {
      expect(() => requireHttpUrl(url), url).toThrow(/valid http:\/\/ or https:\/\/ URL|embedded credentials/);
    }
    expect(() => requireHttpUrl(undefined)).toThrow(/valid http:\/\//);
    expect(() => requireHttpUrl(42)).toThrow(/valid http:\/\//);
  });

  it('is applied by both browser tools before any transport is touched', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return new Response('<title>x</title>', { status: 200 });
    };
    const navigate = createBrowserNavigateTool(transport);
    const vision = createBrowserVisionTool(transport);
    for (const url of refuse) {
      await expect(navigate.run({ url }, context)).rejects.toThrow();
      await expect(vision.run({ url }, context)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
});

describe('browser tools never fetch through a global of their own', () => {
  it('fails closed when no transport was supplied instead of using the ambient fetch', async () => {
    // The ambient `fetch` is present in this test environment; the tool must still refuse, because
    // only the injected transport knows the IRIS destination policy.
    expect(typeof globalThis.fetch).toBe('function');
    await expect(
      createBrowserNavigateTool().run({ url: 'https://example.com/' }, context),
    ).rejects.toThrow(/Fetch implementation is not available/);
    await expect(
      createBrowserVisionTool().run({ url: 'https://example.com/' }, context),
    ).rejects.toThrow(/Fetch implementation is not available/);
  });

  it('forwards a valid target to the injected transport unchanged', async () => {
    const seen: string[] = [];
    const transport = async (url: string) => {
      seen.push(url);
      return new Response('<html><head><title>App</title></head><body>ok</body></html>', {
        status: 200,
      });
    };
    await createBrowserNavigateTool(transport).run({ url: 'https://example.com/app' }, context);
    await createBrowserVisionTool(transport).run({ url: 'https://example.com/app' }, context);
    expect(seen).toEqual(['https://example.com/app', 'https://example.com/app']);
  });

  it('still exposes the shared toolset while routing every read through the transport', () => {
    const ids = createAllBrowserTools(async () => new Response('', { status: 200 })).map(
      (tool) => tool.id,
    );
    expect(ids).toEqual(['browser.navigate', 'browser.vision']);
  });
});
