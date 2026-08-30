import { invoke } from '@tauri-apps/api/core';
import { parseMcpRegistryPage, type McpRegistryPage } from '@iris/mcp';
import { isTauriRuntime } from './credentials';

/**
 * The official MCP registry is the only directory that publishes each remote server's real endpoint,
 * so it is what IRIS browses when the point is to connect rather than merely to look.
 */
export const mcpRegistryDescriptor = {
  id: 'modelcontextprotocol',
  name: 'Official MCP registry',
  homeUrl: 'https://registry.modelcontextprotocol.io',
};

const listEndpoint = 'https://registry.modelcontextprotocol.io/v0.1/servers';

export const mcpRegistryPageSize = 30;

export interface McpRegistryQuery {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface McpRegistryDependencies {
  fetchJson: (url: string, signal?: AbortSignal) => Promise<unknown>;
}

async function defaultFetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  if (!isTauriRuntime()) {
    throw new Error(
      'the registry sends no CORS headers, so it can only be reached from the native IRIS desktop app',
    );
  }
  const body = await invoke<string>('fetch_directory', { url });
  signal?.throwIfAborted();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('The MCP registry returned a response that is not JSON.');
  }
}

function registryUrl(query: McpRegistryQuery): string {
  const url = new URL(listEndpoint);
  url.searchParams.set(
    'limit',
    String(Math.min(100, Math.max(1, Math.floor(query.limit ?? mcpRegistryPageSize)))),
  );
  // Without this the registry returns every historical version of every server.
  url.searchParams.set('version', 'latest');
  if (query.search?.trim()) url.searchParams.set('search', query.search.trim());
  if (query.cursor?.trim()) url.searchParams.set('cursor', query.cursor.trim());
  return url.toString();
}

export class OfficialMcpRegistry {
  constructor(
    private readonly dependencies: McpRegistryDependencies = { fetchJson: defaultFetchJson },
  ) {}

  descriptor() {
    return { ...mcpRegistryDescriptor };
  }

  async browse(query: McpRegistryQuery, signal?: AbortSignal): Promise<McpRegistryPage> {
    return parseMcpRegistryPage(await this.dependencies.fetchJson(registryUrl(query), signal));
  }
}

export const mcpRegistry = new OfficialMcpRegistry();
