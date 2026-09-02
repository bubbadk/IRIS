import { describe, expect, it } from 'vitest';
import {
  createAllBrowserSessionTools,
  createBrowserClickLiveTool,
  createBrowserNavigateLiveTool,
  createBrowserTypeLiveTool,
  createBrowserVisionLiveTool,
  type LiveBrowserDependencies,
} from './liveBrowserTools';

function depsWith(invokeImpl: LiveBrowserDependencies['invokeNative']): LiveBrowserDependencies {
  return { invokeNative: invokeImpl };
}

const NO_SESSION = new Error(
  'No browser session is running. Call browser_start first to launch the automated browser.',
);

const samplePage = {
  url: 'https://example.com/app',
  title: 'App',
  elements: [{ ref: 0, tag: 'a', text: 'Settings', href: '/settings' }],
  textSummary: 'Hello world',
};

describe('live browser tools registration', () => {
  it('registers the full real-automation toolset', () => {
    const ids = createAllBrowserSessionTools().map((tool) => tool.id);
    expect(ids).toEqual([
      'browser.start',
      'browser.navigate',
      'browser.click',
      'browser.type',
      'browser.vision',
      'browser.snapshot',
      'browser.close',
    ]);
  });

  it('describes click and type as real automation, not unavailable stubs', () => {
    const tools = Object.fromEntries(
      createAllBrowserSessionTools().map((tool) => [tool.id, tool]),
    );
    expect(tools['browser.click']?.description).not.toContain('NOT AVAILABLE');
    expect(tools['browser.type']?.description).toContain('WebDriver');
  });
});

describe('browser.navigate live tool', () => {
  it('navigates the real session when one is running', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const tool = createBrowserNavigateLiveTool(
      depsWith(async (command, args) => {
        calls.push([command, args]);
        return samplePage;
      }),
    );
    const result = (await tool.run({ url: 'https://example.com/app' }, {
      agentId: 'a',
      agentName: 'A',
    })) as typeof samplePage;
    expect(result.url).toBe('https://example.com/app');
    expect(calls[0]?.[0]).toBe('browser_navigate');
  });

  it('falls back to honest HTTP fetching when no session is running', async () => {
    const html = `<!doctype html><html><head><title>Fallback Page</title></head><body>
      <h1>Overview</h1><button>Save</button><a href="https://example.com/next">Next</a>
      <p>Main content goes here for the text summary.</p></body></html>`;
    const tool = createBrowserNavigateLiveTool({
      invokeNative: async () => {
        throw NO_SESSION;
      },
      fetchImpl: (async () =>
        new Response(html, { status: 200 })) as unknown as LiveBrowserDependencies['fetchImpl'],
    });
    const result = (await tool.run({ url: 'https://example.com' }, {
      agentId: 'a',
      agentName: 'A',
    })) as Record<string, unknown>;
    expect(result.title).toBe('Fallback Page');
    expect(String(result.note)).toContain('HTTP fetch fallback');
  });

  it('propagates real navigation errors instead of falling back', async () => {
    const tool = createBrowserNavigateLiveTool({
      invokeNative: async () => {
        throw new Error('Browser driver error: net::ERR_NAME_NOT_RESOLVED');
      },
    });
    await expect(
      tool.run({ url: 'https://no-such-host.invalid' }, { agentId: 'a', agentName: 'A' }),
    ).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });
});

describe('browser.click live tool input validation', () => {
  const tool = createBrowserClickLiveTool(depsWith(async () => samplePage));

  it('requires a ref, selector or text', async () => {
    await expect(tool.run({}, { agentId: 'a', agentName: 'A' })).rejects.toThrow(
      /needs one of: ref, selector, or text/,
    );
  });

  it('rejects unsupported fields and out-of-range refs', async () => {
    await expect(
      tool.run({ url: 'https://x' }, { agentId: 'a', agentName: 'A' }),
    ).rejects.toThrow(/unsupported input field/);
    await expect(
      tool.run({ ref: 500 }, { agentId: 'a', agentName: 'A' }),
    ).rejects.toThrow(/ref must be an integer/);
  });

  it('dispatches a real click through the backend', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const clicking = createBrowserClickLiveTool(
      depsWith(async (command, args) => {
        calls.push([command, args]);
        return { action: 'clicked' };
      }),
    );
    await clicking.run({ ref: 3 }, { agentId: 'a', agentName: 'A' });
    expect(calls[0]).toEqual(['browser_click', { reference: 3, selector: undefined, text: undefined }]);
  });
});

describe('browser.type live tool input validation', () => {
  const tool = createBrowserTypeLiveTool(depsWith(async () => samplePage));

  it('requires text and a target', async () => {
    await expect(
      tool.run({ selector: '#q' }, { agentId: 'a', agentName: 'A' }),
    ).rejects.toThrow(/non-empty text/);
    await expect(
      tool.run({ text: 'query' }, { agentId: 'a', agentName: 'A' }),
    ).rejects.toThrow(/needs a ref or a selector/);
  });

  it('rejects oversized text', async () => {
    await expect(
      tool.run({ selector: '#q', text: 'x'.repeat(5001) }, { agentId: 'a', agentName: 'A' }),
    ).rejects.toThrow(/limited to 5000/);
  });

  it('passes clear preference through', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const typing = createBrowserTypeLiveTool(
      depsWith(async (_command, args) => {
        calls.push(args);
        return { action: 'typed' };
      }),
    );
    await typing.run({ selector: '#q', text: 'hi', clear: false }, { agentId: 'a', agentName: 'A' });
    expect(calls[0]).toMatchObject({ selector: '#q', text: 'hi', clear: false });
  });
});

describe('browser.vision live tool', () => {
  it('errors honestly when no session runs and no url is given', async () => {
    const tool = createBrowserVisionLiveTool(
      depsWith(async () => {
        throw NO_SESSION;
      }),
    );
    await expect(tool.run({}, { agentId: 'a', agentName: 'A' })).rejects.toThrow(
      /No browser session is running/,
    );
  });

  it('falls back to HTTP structure parsing with an honest note', async () => {
    const html = `<!doctype html><html><head><title>Static</title></head><body>
      <h1>Doc</h1><button>One</button><form></form></body></html>`;
    const tool = createBrowserVisionLiveTool({
      invokeNative: async () => {
        throw NO_SESSION;
      },
      fetchImpl: (async () =>
        new Response(html, { status: 200 })) as unknown as LiveBrowserDependencies['fetchImpl'],
    });
    const result = (await tool.run({ url: 'https://example.com' }, {
      agentId: 'a',
      agentName: 'A',
    })) as Record<string, unknown>;
    expect(result.title).toBe('Static');
    expect(String(result.note)).toContain('no real screenshot');
  });

  it('navigates first when a url is provided to a running session', async () => {
    const calls: string[] = [];
    const tool = createBrowserVisionLiveTool(
      depsWith(async (command) => {
        calls.push(command);
        if (command === 'browser_vision') {
          return { url: 'https://e.com', title: 'T', mimeType: 'image/png', byteSize: 5, screenshotPath: '/tmp/x.png' };
        }
        return samplePage;
      }),
    );
    const result = (await tool.run({ url: 'https://e.com' }, {
      agentId: 'a',
      agentName: 'A',
    })) as Record<string, unknown>;
    expect(calls).toEqual(['browser_navigate', 'browser_vision']);
    expect(result.screenshotPath).toBe('/tmp/x.png');
  });
});
