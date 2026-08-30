import { invoke } from '@tauri-apps/api/core';
import {
  catalogInstructionsAreDescriptionOnly,
  parseSkillCatalogPage,
  parseSkillDocument,
  skillDocumentCandidates,
  type SkillCatalogDescriptor,
  type SkillCatalogEntry,
  type SkillCatalogPage,
  type SkillCatalogQuery,
  type SkillInstructions,
  type SkillOrigin,
} from '@iris/skills';
import { isTauriRuntime } from './credentials';

/**
 * Skills Playground publishes two different endpoints:
 *
 * - `/api/v1/skills` is paginated and searchable but omits the instruction body.
 * - `/api/skills` carries the instruction body for every skill but ignores all query parameters.
 *
 * Browsing therefore uses v1. Importing first resolves the body from the bulk endpoint, which is
 * fetched at most once per session, then follows the entry's GitHub source when the directory only
 * repeats its description instead of publishing instructions.
 */
const catalogDescriptor: SkillCatalogDescriptor = {
  id: 'skillsplayground',
  name: 'Skills Playground',
  homeUrl: 'https://skillsplayground.com',
};

const listEndpoint = 'https://skillsplayground.com/api/v1/skills';
const bodyEndpoint = 'https://skillsplayground.com/api/skills';

const catalogCategories = [
  'ai-ml',
  'automation',
  'backend',
  'browser-automation',
  'cli',
  'code-review',
  'communication',
  'data',
  'debugging',
  'devops',
  'documentation',
  'finance',
  'frontend',
  'marketing',
  'media',
  'mobile',
  'productivity',
  'prompts',
  'search',
  'security',
  'testing',
  'workflow',
] as const;

export const skillCatalogPageSize = 12;

export interface SkillCatalogDependencies {
  fetchJson: (url: string, signal?: AbortSignal) => Promise<unknown>;
  /** Returns the document text, or null when the address holds nothing. */
  fetchText: (url: string, signal?: AbortSignal) => Promise<string | null>;
}

export interface ImportedSourceRead {
  text: string | null;
  url?: string;
  moved: boolean;
}

/**
 * Skills Playground serves JSON without an `Access-Control-Allow-Origin` header, so a webview fetch
 * is blocked by the same-origin policy. The native desktop routes the request through a Rust command
 * with a fixed host/path allowlist; the browser preview has no such escape and says so.
 */
async function defaultFetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  if (!isTauriRuntime()) {
    throw new Error(
      'the catalog sends no CORS headers, so it can only be reached from the native IRIS desktop app',
    );
  }
  const body = await invoke<string>('fetch_directory', { url });
  signal?.throwIfAborted();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('The skill catalog returned a response that is not JSON.');
  }
}

async function defaultFetchText(url: string, signal?: AbortSignal): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new Error('source repositories can only be read from the native IRIS desktop app');
  }
  try {
    const body = await invoke<string>('fetch_directory', { url });
    signal?.throwIfAborted();
    return body;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A missing document is an ordinary outcome because candidates include conventional names.
    if (/\b404\b|not found/i.test(message)) return null;
    throw new Error(`The skill source repository could not be read: ${message}`);
  }
}

function catalogUrl(query: SkillCatalogQuery): string {
  const url = new URL(listEndpoint);
  url.searchParams.set('page', String(Math.max(1, Math.floor(query.page ?? 1))));
  url.searchParams.set(
    'limit',
    String(Math.min(100, Math.max(1, Math.floor(query.limit ?? skillCatalogPageSize)))),
  );
  if (query.query?.trim()) url.searchParams.set('q', query.query.trim());
  if (query.category?.trim()) url.searchParams.set('category', query.category.trim());
  return url.toString();
}

export class SkillsPlaygroundCatalog {
  private bodies: Map<string, string> | null = null;
  private pendingBodies: Promise<Map<string, string>> | null = null;

  constructor(
    private readonly dependencies: SkillCatalogDependencies = {
      fetchJson: defaultFetchJson,
      fetchText: defaultFetchText,
    },
  ) {}

  descriptor(): SkillCatalogDescriptor {
    return { ...catalogDescriptor };
  }

  categories(): readonly string[] {
    return catalogCategories;
  }

  async browse(query: SkillCatalogQuery, signal?: AbortSignal): Promise<SkillCatalogPage> {
    const payload = await this.dependencies.fetchJson(catalogUrl(query), signal);
    return parseSkillCatalogPage(payload, query.limit ?? skillCatalogPageSize);
  }

  /**
   * The directory repeats the description in its instruction field for all but 117 of its entries,
   * so a body that is really just the description is treated as absent and the skill's own source
   * repository is read instead. That is where the instructions actually live.
   */
  async instructions(
    entry: SkillCatalogEntry,
    signal?: AbortSignal,
  ): Promise<SkillInstructions | null> {
    const bodies = await this.loadBodies(signal);
    const catalogBody = bodies.get(entry.slug) ?? '';
    if (catalogBody && !catalogInstructionsAreDescriptionOnly(entry, catalogBody)) {
      return { body: catalogBody, origin: 'catalog' };
    }
    if (entry.sourceUrl) {
      for (const candidate of skillDocumentCandidates(entry.sourceUrl, entry.slug)) {
        const text = await this.dependencies.fetchText(candidate, signal);
        if (!text?.trim()) continue;
        const document = parseSkillDocument(text);
        if (!document.body) continue;
        return { body: document.body, origin: 'repository', url: candidate };
      }
    }
    return catalogBody ? { body: catalogBody, origin: 'catalog' } : null;
  }

  /** Re-reads the exact document saved at import time, then looks for a moved document only. */
  async readImportedSource(
    origin: Extract<SkillOrigin, { kind: 'imported' }>,
    signal?: AbortSignal,
  ): Promise<ImportedSourceRead> {
    if (origin.sourceUrl) {
      try {
        const exact = await this.dependencies.fetchText(origin.sourceUrl, signal);
        if (exact?.trim()) {
          return { text: parseSkillDocument(exact).body, url: origin.sourceUrl, moved: false };
        }
      } catch {
        // A source may have moved or been deleted; repository candidates below decide which state.
      }
    }
    const repositoryUrl =
      origin.repositoryUrl ??
      (origin.sourceUrl?.startsWith('https://github.com/') ? origin.sourceUrl : undefined);
    if (repositoryUrl) {
      for (const candidate of skillDocumentCandidates(repositoryUrl, origin.slug)) {
        if (candidate === origin.sourceUrl) continue;
        let text: string | null;
        try {
          text = await this.dependencies.fetchText(candidate, signal);
        } catch {
          continue;
        }
        if (!text?.trim()) continue;
        const body = parseSkillDocument(text).body;
        if (body) return { text: body, url: candidate, moved: true };
      }
    }
    return { text: null, moved: Boolean(origin.sourceUrl || repositoryUrl) };
  }

  /** The bulk endpoint is large, so it is fetched once and shared by every later import. */
  private loadBodies(signal?: AbortSignal): Promise<Map<string, string>> {
    if (this.bodies) return Promise.resolve(this.bodies);
    if (!this.pendingBodies) {
      this.pendingBodies = this.dependencies
        .fetchJson(bodyEndpoint, signal)
        .then((payload) => {
          if (!Array.isArray(payload)) {
            throw new Error('The skill catalog returned an unreadable instruction list.');
          }
          const bodies = new Map<string, string>();
          for (const item of payload) {
            if (!item || typeof item !== 'object') continue;
            const record = item as Record<string, unknown>;
            const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
            const body = typeof record.systemPrompt === 'string' ? record.systemPrompt.trim() : '';
            if (slug && body) bodies.set(slug, body);
          }
          this.bodies = bodies;
          return bodies;
        })
        .finally(() => {
          this.pendingBodies = null;
        });
    }
    return this.pendingBodies;
  }
}

export const skillCatalog = new SkillsPlaygroundCatalog();
