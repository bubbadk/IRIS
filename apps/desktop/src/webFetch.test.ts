import { afterEach, expect, it, vi } from 'vitest';
import { webToolFetch } from './webFetch';
const { invoke, isTauri } = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('routes installed-app public reads through native transport without forwarding credentials', async () => {
  isTauri.mockReturnValue(true);
  invoke.mockResolvedValue({ status: 200, body: '<h1>Read</h1>', contentType: 'text/html' });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await (await webToolFetch('https://example.com')).text()).toContain('Read');
  expect(invoke).toHaveBeenCalledWith('web_read_public_page', { url: 'https://example.com' });
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps native errors instead of falling back to a blocked browser request', async () => {
  isTauri.mockReturnValue(true);
  invoke.mockRejectedValue('The web request timed out after 20 seconds.');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(webToolFetch('https://example.com')).rejects.toContain('timed out');
  expect(fetch).not.toHaveBeenCalled();
});
it('explains preview network failures instead of exposing only Load failed', async () => {
  isTauri.mockReturnValue(false);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
  await expect(webToolFetch('https://example.com')).rejects.toThrow('installed IRIS app');
});
