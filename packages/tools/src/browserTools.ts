import type { RegisteredTool } from './index';

export interface BrowserNavigateInput {
  url: string;
  timeoutMs?: number;
}

export interface BrowserElementSummary {
  tag: string;
  text: string;
  selector?: string;
  href?: string;
}

export interface BrowserNavigateOutput {
  url: string;
  title: string;
  statusCode: number;
  headings: string[];
  interactiveElements: BrowserElementSummary[];
  textSummary: string;
}

export interface BrowserClickInput {
  url: string;
  selector?: string;
  text?: string;
}

export interface BrowserClickOutput {
  url: string;
  action: 'clicked';
  target: string;
  success: boolean;
  message: string;
}

export interface BrowserTypeInput {
  url: string;
  selector: string;
  text: string;
}

export interface BrowserTypeOutput {
  url: string;
  action: 'typed';
  selector: string;
  textLength: number;
  success: boolean;
}

export interface BrowserVisionInput {
  url: string;
  fullPage?: boolean;
}

export interface BrowserVisionOutput {
  url: string;
  title: string;
  pageStructure: {
    headings: string[];
    linksCount: number;
    buttonsCount: number;
    formsCount: number;
  };
  visualContent: string;
}

export function createBrowserNavigateTool(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RegisteredTool {
  const fetchImpl = customFetch || (typeof fetch !== 'undefined' ? fetch : undefined);

  return {
    id: 'browser.navigate',
    name: 'Browser Navigate',
    description:
      'Fetches a web page over HTTP (no JavaScript execution) and parses the HTML for title, headings, interactive elements, and body text.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The HTTP or HTTPS URL to navigate to.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum navigation timeout in milliseconds (default: 15000).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(input: unknown): Promise<BrowserNavigateOutput> {
      if (!input || typeof input !== 'object') {
        throw new Error('Browser navigation requires an input object with a "url" field.');
      }
      const { url } = input as BrowserNavigateInput;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        throw new Error('Valid HTTP/HTTPS URL is required.');
      }

      if (!fetchImpl) {
        throw new Error('Fetch implementation is not available in the current environment.');
      }

      try {
        const response = await fetchImpl(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 IRIS/0.2.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (!response.ok) {
          throw new Error(`Browser navigation to ${url} failed with status: ${response.status}`);
        }

        const html = await response.text();

        // Extract title
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1]?.trim() : 'Web Document';

        // Extract headings
        const headings: string[] = [];
        const headingRegex = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi;
        let hMatch: RegExpExecArray | null;
        while ((hMatch = headingRegex.exec(html)) !== null && headings.length < 10) {
          const text = hMatch[1]?.replace(/<[^>]+>/g, '').trim();
          if (text) headings.push(text);
        }

        // Extract interactive elements (buttons, links, inputs)
        const interactiveElements: BrowserElementSummary[] = [];
        const buttonRegex = /<button[^>]*>(.*?)<\/button>/gi;
        let btnMatch: RegExpExecArray | null;
        while ((btnMatch = buttonRegex.exec(html)) !== null && interactiveElements.length < 15) {
          const btnText = btnMatch[1]?.replace(/<[^>]+>/g, '').trim();
          if (btnText) {
            interactiveElements.push({
              tag: 'button',
              text: btnText,
              selector: `button:contains("${btnText.slice(0, 20)}")`,
            });
          }
        }

        const linkRegex = /<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
        let lMatch: RegExpExecArray | null;
        while ((lMatch = linkRegex.exec(html)) !== null && interactiveElements.length < 30) {
          const href = lMatch[1];
          const lText = lMatch[2]?.replace(/<[^>]+>/g, '').trim();
          if (lText && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
            interactiveElements.push({
              tag: 'a',
              text: lText,
              href,
              selector: `a[href="${href}"]`,
            });
          }
        }

        // Clean body text summary
        const textSummary = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1500);

        return {
          url,
          title,
          statusCode: response.status,
          headings,
          interactiveElements,
          textSummary,
        };
      } catch (err) {
        throw new Error(
          `Browser navigation error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export function createBrowserClickTool(): RegisteredTool {
  return {
    id: 'browser.click',
    name: 'Browser Click',
    description:
      'NOT AVAILABLE: IRIS has no headless browser backend, so elements cannot actually be clicked. Calling this tool always fails.',
    risk: 'execute',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The active browser URL.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of the element to click.',
        },
        text: {
          type: 'string',
          description: 'Visible text label of the element to click.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(): Promise<BrowserClickOutput> {
      throw new Error(
        'browser.click is not available: IRIS has no headless browser backend. No element was clicked. Use browser.navigate to inspect page structure instead.',
      );
    },
  };
}

export function createBrowserTypeTool(): RegisteredTool {
  return {
    id: 'browser.type',
    name: 'Browser Type Text',
    description:
      'NOT AVAILABLE: IRIS has no headless browser backend, so text cannot actually be typed into fields. Calling this tool always fails.',
    risk: 'execute',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The active browser URL.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or name of the input field.',
        },
        text: {
          type: 'string',
          description: 'The text string to type into the field.',
        },
      },
      required: ['url', 'selector', 'text'],
      additionalProperties: false,
    },
    async run(): Promise<BrowserTypeOutput> {
      throw new Error(
        'browser.type is not available: IRIS has no headless browser backend. No text was typed. Use browser.navigate to inspect page structure instead.',
      );
    },
  };
}

export function createBrowserVisionTool(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RegisteredTool {
  const fetchImpl = customFetch || (typeof fetch !== 'undefined' ? fetch : undefined);

  return {
    id: 'browser.vision',
    name: 'Browser Vision Snapshot',
    description:
      'Fetches a web page over HTTP (no JavaScript execution) and returns a text-based structural snapshot (title, headings, element counts, body text) for reasoning. This is not a rendered visual screenshot.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The webpage URL to inspect visually.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Whether to capture the entire scrolling viewport (default: false).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(input: unknown): Promise<BrowserVisionOutput> {
      if (!input || typeof input !== 'object') {
        throw new Error('Browser vision requires an input object with a "url" field.');
      }
      const { url } = input as BrowserVisionInput;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        throw new Error('Valid HTTP/HTTPS URL is required.');
      }

      if (!fetchImpl) {
        throw new Error('Fetch implementation is not available in the current environment.');
      }

      try {
        const response = await fetchImpl(url);
        const html = await response.text();

        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1]?.trim() : 'Webpage';

        const headings: string[] = [];
        const hRegex = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi;
        let match: RegExpExecArray | null;
        while ((match = hRegex.exec(html)) !== null && headings.length < 8) {
          const text = match[1]?.replace(/<[^>]+>/g, '').trim();
          if (text) headings.push(text);
        }

        const linksCount = (html.match(/<a\b[^>]*>/gi) || []).length;
        const buttonsCount = (html.match(/<button\b[^>]*>/gi) || []).length;
        const formsCount = (html.match(/<form\b[^>]*>/gi) || []).length;

        const visualContent = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2000);

        return {
          url,
          title,
          pageStructure: {
            headings,
            linksCount,
            buttonsCount,
            formsCount,
          },
          visualContent,
        };
      } catch (err) {
        throw new Error(
          `Browser vision failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export function createAllBrowserTools(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RegisteredTool[] {
  // browser.click and browser.type are intentionally NOT registered: IRIS has no
  // headless browser backend, and registering them would present fake affordances.
  return [
    createBrowserNavigateTool(customFetch),
    createBrowserVisionTool(customFetch),
  ];
}
