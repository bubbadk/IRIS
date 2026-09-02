import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';
import { createBrowserNavigateTool, createBrowserVisionTool } from '@iris/tools';

/**
 * Real browser automation backed by the Rust WebDriver session (chromedriver +
 * headless Chrome). Clicks and key presses are genuine WebDriver input events.
 * navigate/vision degrade to plain HTTP fetching when no browser session is
 * running, stated plainly in their outputs — they never pretend a browser exists.
 */

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface LiveBrowserDependencies {
  invokeNative: InvokeFn;
  fetchImpl?: FetchImpl;
}

export interface BrowserElementRef {
  ref: number;
  tag: string;
  text: string;
  href?: string | null;
  type?: string | null;
  placeholder?: string | null;
  id?: string | null;
  name?: string | null;
}

export interface BrowserPageState {
  url: string;
  title: string;
  elements: BrowserElementRef[];
  textSummary: string;
}

export interface BrowserActionResult {
  url: string;
  title: string;
  action: string;
  target: string;
  page: BrowserPageState;
}

export interface BrowserVisionResult {
  url: string;
  title: string;
  mimeType: string;
  byteSize: number;
  screenshotPath: string | null;
}

const NO_SESSION_PATTERN = /No browser session is running/;

function inputObject(input: unknown, toolName: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${toolName} requires an object input.`);
  }
  return input as Record<string, unknown>;
}

function optionalBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function requireUrl(input: Record<string, unknown>): string {
  const url = input.url;
  if (typeof url !== 'string' || !url.trim().startsWith('http')) {
    throw new Error('A valid http:// or https:// URL is required.');
  }
  return url.trim();
}

export function createBrowserStartTool(deps: LiveBrowserDependencies): RegisteredTool {
  return {
    id: 'browser.start',
    name: 'Start automated browser',
    description:
      'Launches a real headless Chrome/Chromium session through WebDriver for interactive automation. No browser is running until this is called; browser.click, browser.type and browser.vision require it.',
    risk: 'execute',
    providerName: 'browser_start',
    manualExecution: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(input) {
      const value = inputObject(input, 'Start automated browser');
      if (Object.keys(value).length > 0) {
        throw new Error('Start automated browser takes no input fields.');
      }
      const page = (await deps.invokeNative('browser_start')) as BrowserPageState;
      return {
        ...page,
        note: 'Browser session is running. Use browser.click with a ref from this snapshot, browser.type for fields, browser.vision to save a screenshot, browser.close to end the session.',
      };
    },
  };
}

export function createBrowserNavigateLiveTool(deps: LiveBrowserDependencies): RegisteredTool {
  const fallback = createBrowserNavigateTool(deps.fetchImpl);
  return {
    id: 'browser.navigate',
    name: 'Browser Navigate',
    description:
      'With a running browser session: navigates the real headless browser (JavaScript executes) and returns the loaded page with clickable element refs. Without a session: falls back to a plain HTTP fetch with no JavaScript, which is stated in the result.',
    risk: 'read',
    providerName: 'browser_navigate',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to open.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Browser Navigate');
      const url = requireUrl(value);
      try {
        return await deps.invokeNative('browser_navigate', { url });
      } catch (error) {
        if (error instanceof Error && NO_SESSION_PATTERN.test(error.message)) {
          const result = (await fallback.run({ url }, {
            agentId: '',
            agentName: '',
          })) as Record<string, unknown>;
          return { ...result, note: 'HTTP fetch fallback — no browser session is running, so JavaScript did not execute.' };
        }
        throw error;
      }
    },
  };
}

export function createBrowserClickLiveTool(deps: LiveBrowserDependencies): RegisteredTool {
  return {
    id: 'browser.click',
    name: 'Browser Click',
    description:
      'Clicks a real element in the running automated browser session (trusted WebDriver click). Target it by ref from the latest page snapshot, a CSS selector, or visible text. Requires browser.start first.',
    risk: 'execute',
    providerName: 'browser_click',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'integer',
          minimum: 0,
          description: 'Element ref index from the latest browser page snapshot.',
        },
        selector: { type: 'string', description: 'CSS selector of the element.' },
        text: { type: 'string', description: 'Visible text label of the element.' },
      },
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Browser Click');
      const allowed = new Set(['ref', 'selector', 'text']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('Browser Click received an unsupported input field.');
      }
      const reference = optionalBoundedInteger(value.ref, 'ref', 0, 149);
      const selector = typeof value.selector === 'string' ? value.selector : undefined;
      const text = typeof value.text === 'string' ? value.text : undefined;
      if (reference === undefined && !selector?.trim() && !text?.trim()) {
        throw new Error('Browser Click needs one of: ref, selector, or text.');
      }
      return deps.invokeNative('browser_click', { reference, selector, text });
    },
  };
}

export function createBrowserTypeLiveTool(deps: LiveBrowserDependencies): RegisteredTool {
  return {
    id: 'browser.type',
    name: 'Browser Type Text',
    description:
      'Types real keystrokes into a field of the running automated browser session (WebDriver send-keys; clears the field first unless clear=false). Target by ref or CSS selector. Requires browser.start first.',
    risk: 'execute',
    providerName: 'browser_type',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'integer',
          minimum: 0,
          description: 'Element ref index from the latest browser page snapshot.',
        },
        selector: { type: 'string', description: 'CSS selector of the input field.' },
        text: { type: 'string', description: 'The text to type.' },
        clear: {
          type: 'boolean',
          description: 'Clear the field before typing (default true).',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Browser Type Text');
      const allowed = new Set(['ref', 'selector', 'text', 'clear']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('Browser Type Text received an unsupported input field.');
      }
      if (typeof value.text !== 'string' || value.text.length === 0) {
        throw new Error('Browser Type Text needs non-empty text to type.');
      }
      if (value.text.length > 5000) {
        throw new Error('Browser Type Text is limited to 5000 characters per call.');
      }
      const reference = optionalBoundedInteger(value.ref, 'ref', 0, 149);
      const selector = typeof value.selector === 'string' ? value.selector : undefined;
      if (reference === undefined && !selector?.trim()) {
        throw new Error('Browser Type Text needs a ref or a selector to find the field.');
      }
      if (value.clear !== undefined && typeof value.clear !== 'boolean') {
        throw new Error('clear must be a boolean.');
      }
      return deps.invokeNative('browser_type', {
        reference,
        selector,
        text: value.text,
        clear: value.clear,
      });
    },
  };
}

export function createBrowserVisionLiveTool(deps: LiveBrowserDependencies): RegisteredTool {
  const fallback = createBrowserVisionTool(deps.fetchImpl);
  return {
    id: 'browser.vision',
    name: 'Browser Vision Snapshot',
    description:
      'With a running browser session: captures a real screenshot of the headless browser and saves it as a PNG in the workspace (iris-vision/) — returns the file path plus the page title and URL. Without a session: falls back to HTTP-only structural parsing, stated in the result.',
    risk: 'read',
    providerName: 'browser_vision',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional URL to open before capturing. Uses the current page when omitted.',
        },
      },
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Browser Vision Snapshot');
      const allowed = new Set(['url']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('Browser Vision Snapshot received an unsupported input field.');
      }
      const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined;
      try {
        if (url) {
          await deps.invokeNative('browser_navigate', { url });
        }
        return await deps.invokeNative('browser_vision');
      } catch (error) {
        if (error instanceof Error && NO_SESSION_PATTERN.test(error.message)) {
          if (!url) {
            throw new Error(
              'No browser session is running. Pass a url for HTTP-only inspection, or call browser.start first.',
            );
          }
          const result = (await fallback.run({ url }, {
            agentId: '',
            agentName: '',
          })) as Record<string, unknown>;
          return {
            ...result,
            note: 'HTTP fetch fallback — no browser session is running, so there is no real screenshot.',
          };
        }
        throw error;
      }
    },
  };
}

export function createBrowserSnapshotTool(deps: LiveBrowserDependencies): RegisteredTool {
  return {
    id: 'browser.snapshot',
    name: 'Browser Page Snapshot',
    description:
      'Returns the current page of the running automated browser: URL, title, clickable element refs and visible text. Use it to refresh stale refs after a click changes the page.',
    risk: 'read',
    providerName: 'browser_snapshot',
    manualExecution: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(input) {
      const value = inputObject(input, 'Browser Page Snapshot');
      if (Object.keys(value).length > 0) {
        throw new Error('Browser Page Snapshot takes no input fields.');
      }
      return deps.invokeNative('browser_snapshot');
    },
  };
}

export function createBrowserCloseTool(deps: LiveBrowserDependencies): RegisteredTool {
  return {
    id: 'browser.close',
    name: 'Close automated browser',
    description:
      'Ends the automated browser session: closes the page, the browser and the driver process.',
    risk: 'execute',
    providerName: 'browser_close',
    manualExecution: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(input) {
      const value = inputObject(input, 'Close automated browser');
      if (Object.keys(value).length > 0) {
        throw new Error('Close automated browser takes no input fields.');
      }
      return deps.invokeNative('browser_close');
    },
  };
}

export function createAllLiveBrowserTools(deps: LiveBrowserDependencies): RegisteredTool[] {
  return [
    createBrowserStartTool(deps),
    createBrowserNavigateLiveTool(deps),
    createBrowserClickLiveTool(deps),
    createBrowserTypeLiveTool(deps),
    createBrowserVisionLiveTool(deps),
    createBrowserSnapshotTool(deps),
    createBrowserCloseTool(deps),
  ];
}

const defaultDependencies: LiveBrowserDependencies = {
  invokeNative: (command, args) => invoke(command, args),
};

export function createAllBrowserSessionTools(): RegisteredTool[] {
  return createAllLiveBrowserTools(defaultDependencies);
}
