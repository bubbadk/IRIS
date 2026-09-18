import { invoke, isTauri } from '@tauri-apps/api/core';

/** Desktop-only transport adapter. Domain tools and their permission gates remain unchanged. */
export async function webToolFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauri() && (!init?.method || init.method === 'GET')) {
    const result = await invoke<{ status: number; body: string; contentType: string }>(
      'web_read_public_page',
      { url },
    );
    return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
      headers: { 'content-type': result.contentType },
    });
  }
  try {
    return await globalThis.fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(
      'The web request could not be read. Check the network connection; browser preview may block cross-site requests. Use the installed IRIS app for public webpage reads.',
    );
  }
}
