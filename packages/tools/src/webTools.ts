import type { RegisteredTool, ToolContext } from './index';

export interface WebSearchInput {
  query: string;
  limit?: number;
  domain?: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  query: string;
  count: number;
  results: WebSearchResultItem[];
  summary?: string;
}

export interface WebExtractInput {
  url: string;
  mode?: 'markdown' | 'text' | 'raw';
  apiKey?: string;
}

export interface WebExtractOutput {
  url: string;
  title: string;
  markdown: string;
  metadata?: {
    statusCode?: number;
    description?: string;
    language?: string;
  };
}

export function cleanHtmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
    .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>(.*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

export function createWebSearchTool(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RegisteredTool {
  const fetchImpl = customFetch || (typeof fetch !== 'undefined' ? fetch : undefined);

  return {
    id: 'web.search',
    name: 'Search Web',
    description:
      'Performs an agent-grade web search across the internet, returning relevant titles, URL citations, and summarized snippets.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query or research topic.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of search results to return (1-10, default: 5).',
        },
        domain: {
          type: 'string',
          description: 'Optional domain or website to restrict or prioritize search results to.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(input: unknown, _context: ToolContext): Promise<WebSearchOutput> {
      if (!input || typeof input !== 'object') {
        throw new Error('Web search requires an input object with a "query" field.');
      }
      const { query, limit = 5, domain } = input as WebSearchInput;
      if (!query || typeof query !== 'string' || !query.trim()) {
        throw new Error('Search query must be a non-empty string.');
      }

      if (!fetchImpl) {
        throw new Error('Fetch implementation is not available in the current environment.');
      }

      const searchQuery = domain ? `site:${domain} ${query.trim()}` : query.trim();
      const encodedQuery = encodeURIComponent(searchQuery);

      try {
        const endpoint = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
        const response = await fetchImpl(endpoint, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          },
        });

        if (!response.ok) {
          throw new Error(`Search request failed with status: ${response.status}`);
        }

        const html = await response.text();
        const results: WebSearchResultItem[] = [];

        // Parse DuckDuckGo HTML results
        const regex = /<a class="result__url" href="([^"]+)".*?<h2 class="result__title">.*?<a.*?>(.*?)<\/a>.*?<a class="result__snippet".*?>(.*?)<\/a>/gis;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(html)) !== null && results.length < Math.min(10, limit)) {
          let url = match[1]?.trim() || '';
          if (url.includes('uddg=')) {
            const parsed = new URL(url, 'https://duckduckgo.com');
            url = decodeURIComponent(parsed.searchParams.get('uddg') || url);
          }
          const rawTitle = match[2]?.replace(/<[^>]+>/g, '').trim() || 'Untitled';
          const rawSnippet = match[3]?.replace(/<[^>]+>/g, '').trim() || '';

          if (url.startsWith('http')) {
            results.push({
              title: rawTitle,
              url,
              snippet: rawSnippet,
            });
          }
        }

        // Fallback if regex missed: simpler pattern
        if (results.length === 0) {
          const linkRegex = /<a class="result__snippet[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
          let linkMatch: RegExpExecArray | null;
          while ((linkMatch = linkRegex.exec(html)) !== null && results.length < limit) {
            results.push({
              title: `Search Result ${results.length + 1}`,
              url: linkMatch[1] || '',
              snippet: linkMatch[2]?.replace(/<[^>]+>/g, '').trim() || '',
            });
          }
        }

        return {
          query: query.trim(),
          count: results.length,
          results,
          summary:
            results.length > 0
              ? `Found ${results.length} relevant search results for "${query.trim()}".`
              : `No direct search results found for "${query.trim()}".`,
        };
      } catch (err) {
        throw new Error(`Web search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export function createWebExtractTool(
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RegisteredTool {
  const fetchImpl = customFetch || (typeof fetch !== 'undefined' ? fetch : undefined);

  return {
    id: 'web.extract',
    name: 'Extract Webpage Content',
    description:
      'Extracts full webpage content and converts it into clean, sanitized GitHub Flavored Markdown via Firecrawl / resilient extraction gateway without ads or popups.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the webpage to scrape and extract content from.',
        },
        mode: {
          type: 'string',
          enum: ['markdown', 'text', 'raw'],
          description: 'Extraction output mode (default: markdown).',
        },
        apiKey: {
          type: 'string',
          description: 'Optional Firecrawl API Key if using custom hosted Firecrawl instance.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(input: unknown, _context: ToolContext): Promise<WebExtractOutput> {
      if (!input || typeof input !== 'object') {
        throw new Error('Web extraction requires an input object with a "url" field.');
      }
      const { url, apiKey } = input as WebExtractInput;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        throw new Error('A valid http/https URL is required.');
      }

      if (!fetchImpl) {
        throw new Error('Fetch implementation is not available in the current environment.');
      }

      try {
        if (apiKey) {
          const firecrawlRes = await fetchImpl('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              url,
              formats: ['markdown'],
            }),
          });

          if (firecrawlRes.ok) {
            const data = (await firecrawlRes.json()) as any;
            if (data?.data?.markdown) {
              return {
                url,
                title: data.data.metadata?.title || 'Extracted Document',
                markdown: data.data.markdown,
                metadata: {
                  statusCode: data.data.metadata?.statusCode || 200,
                  description: data.data.metadata?.description,
                  language: data.data.metadata?.language,
                },
              };
            }
          }
        }

        const directRes = await fetchImpl(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 IRIS/0.2.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (!directRes.ok) {
          throw new Error(`Failed to retrieve URL ${url} (HTTP ${directRes.status})`);
        }

        const html = await directRes.text();
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1]?.trim() : 'Extracted Webpage';
        const markdown = cleanHtmlToMarkdown(html);

        return {
          url,
          title,
          markdown,
          metadata: {
            statusCode: directRes.status,
          },
        };
      } catch (err) {
        throw new Error(`Web extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
