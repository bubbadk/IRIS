import { invoke } from '@tauri-apps/api/core';
import {
  McpAuthorizationError,
  McpClient,
  McpOAuthTokenError,
  cloneMcpServer,
  isSupportedMcpServerRequestMethod,
  parseMcpElicitationRequest,
  parseMcpSamplingRequest,
  mcpAuthKind,
  mcpToolId,
  protectedResourceMetadataUrls,
  requireMcpServerName,
  requireMcpServerUrl,
  type McpOAuthBinding,
  type McpOAuthClient,
  type McpOAuthTokens,
  type McpElicitationRequest,
  type McpElicitationResponse,
  type McpStdioConfiguration,
  type McpServerConnection,
  type McpServerInfo,
  type McpPromptDescriptor,
  type McpPromptResult,
  type McpCompletionRequest,
  type McpCompletionResult,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpResourceReadResult,
  type SupportedMcpServerRequestMethod,
  type McpToolDescriptor,
  type McpTransport,
  type McpTransportRequest,
  type McpTransportResponse,
} from '@iris/mcp';
import {
  createModelProvider,
  loadProviderConfigs,
  missingProviderConnectionFields,
  type ModelMessage,
} from '@iris/providers';
import type { RegisteredTool } from '@iris/tools';
import {
  isTauriRuntime,
  deleteProviderSecrets,
  loadProviderSecrets,
  saveProviderSecrets,
} from './credentials';
import {
  mcpServerRepository,
  mcpServerRequestPolicyRepository,
  type McpServerRequestPolicyDecision,
} from './persistence';
import { workspaceRepository } from './persistence';
import { refreshTokens, signIn, tokensAreFresh, type McpSignInResult } from './mcpOAuth';
import { toolRegistry } from './tooling';

/**
 * Tauri rejects a failing command with a plain string rather than an Error, so a caught value is
 * normalised here instead of being reported as a generic failure.
 */
export function describeMcpError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'The MCP server could not be reached.';
}

/**
 * MCP tokens live in the same OS keyring as provider secrets, under their own namespace. The
 * keyring only accepts alphanumerics, dashes and underscores, so the namespace is separated with an
 * underscore rather than a colon.
 */
function tokenKey(serverId: string): string {
  return `mcp_${serverId}`;
}

export async function saveMcpToken(serverId: string, token: string): Promise<boolean> {
  return saveProviderSecrets(tokenKey(serverId), { apiKey: token });
}

export interface McpOAuthCredentials {
  version: 1;
  tokens: McpOAuthTokens;
  clientSecret?: string;
}

export function parseMcpOAuthCredentials(stored: string): McpOAuthCredentials | null {
  try {
    const parsed = JSON.parse(stored) as Partial<McpOAuthCredentials & McpOAuthTokens>;
    if (parsed.version === 1 && parsed.tokens && typeof parsed.tokens.accessToken === 'string') {
      return parsed as McpOAuthCredentials;
    }
    // Connections written before client-secret persistence stored the token object directly.
    return typeof parsed.accessToken === 'string'
      ? { version: 1, tokens: parsed as McpOAuthTokens }
      : null;
  } catch {
    return null;
  }
}

/** OAuth tokens and an optional DCR client secret share one OS-keyring entry, never local metadata. */
async function saveMcpOAuthCredentials(
  serverId: string,
  tokens: McpOAuthTokens,
  clientSecret?: string,
): Promise<void> {
  const credentials: McpOAuthCredentials = {
    version: 1,
    tokens,
    ...(clientSecret ? { clientSecret } : {}),
  };
  await saveProviderSecrets(tokenKey(serverId), { apiKey: JSON.stringify(credentials) });
}

async function loadMcpOAuthCredentials(serverId: string): Promise<McpOAuthCredentials | null> {
  const stored = await loadMcpToken(serverId);
  return stored ? parseMcpOAuthCredentials(stored) : null;
}

export async function loadMcpToken(serverId: string): Promise<string | null> {
  const stored = await loadProviderSecrets(tokenKey(serverId));
  const token = stored?.apiKey;
  return typeof token === 'string' && token.trim() ? token : null;
}

export async function deleteMcpToken(serverId: string): Promise<void> {
  await deleteProviderSecrets(tokenKey(serverId));
}

export class NativeMcpTransport implements McpTransport {
  async send(request: McpTransportRequest, signal?: AbortSignal): Promise<McpTransportResponse> {
    if (!isTauriRuntime()) {
      throw new Error('MCP servers can only be reached from the native IRIS desktop app.');
    }
    const response = await invoke<McpTransportResponse>('mcp_request', {
      url: request.url,
      payload: request.payload,
      token: request.token ?? null,
      sessionId: request.sessionId ?? null,
    });
    signal?.throwIfAborted();
    return response;
  }
}

export const mcpTransport = new NativeMcpTransport();

/** Native-only bridge for an explicitly configured local stdio MCP command. */
export class NativeStdioMcpTransport implements McpTransport {
  constructor(private readonly configuration: McpStdioConfiguration) {}

  async send(request: McpTransportRequest, signal?: AbortSignal): Promise<McpTransportResponse> {
    if (!isTauriRuntime()) {
      throw new Error('Local stdio MCP servers can only run from the native IRIS desktop app.');
    }
    const response = await invoke<McpTransportResponse>('mcp_stdio_request', {
      request: { ...this.configuration, payload: request.payload },
      sessionId: request.sessionId ?? null,
    });
    signal?.throwIfAborted();
    return response;
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId && isTauriRuntime()) {
      await invoke('mcp_close_stdio_session', { sessionId });
    }
  }
}

const listeners = new Set<() => void>();
const elicitationListeners = new Set<() => void>();
const pendingElicitations = new Map<
  string,
  {
    serverId: string;
    request: McpElicitationPending;
    resolve: (response: McpElicitationResponse) => void;
  }
>();

export interface McpElicitationPending {
  id: string;
  serverId: string;
  serverName: string;
  request: McpElicitationRequest;
  provenance: { method: string; requestId: number | string; serverUrl: string; sessionId?: string };
}

export function subscribeMcpElicitations(listener: () => void): () => void {
  elicitationListeners.add(listener);
  return () => elicitationListeners.delete(listener);
}

export function listPendingMcpElicitations(): McpElicitationPending[] {
  return [...pendingElicitations.values()].map(({ request }) => request);
}

export function resolveMcpElicitation(id: string, response: McpElicitationResponse): boolean {
  const pending = pendingElicitations.get(id);
  if (!pending) return false;
  pendingElicitations.delete(id);
  pending.resolve(response);
  elicitationListeners.forEach((listener) => listener());
  return true;
}

function requestElicitation(
  server: McpServerConnection,
  request: import('@iris/mcp').McpServerRequest,
  signal: AbortSignal,
): Promise<McpElicitationResponse> {
  const parsed = parseMcpElicitationRequest(request.params);
  if (!parsed)
    return Promise.reject(new Error('IRIS supports only bounded form-mode MCP elicitations.'));
  const id = `${server.id}:${String(request.id)}`;
  return new Promise((resolve, reject) => {
    const pending: McpElicitationPending = {
      id,
      serverId: server.id,
      serverName: server.name,
      request: parsed,
      provenance: request.provenance,
    };
    const abort = () => {
      pendingElicitations.delete(id);
      elicitationListeners.forEach((listener) => listener());
      reject(signal.reason instanceof Error ? signal.reason : new Error('Elicitation cancelled.'));
    };
    pendingElicitations.set(id, { serverId: server.id, request: pending, resolve });
    signal.addEventListener('abort', abort, { once: true });
    elicitationListeners.forEach((listener) => listener());
  });
}

export function subscribeMcpServers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyMcpChanged(): void {
  listeners.forEach((listener) => listener());
}

export interface McpConnectionResult {
  server: McpServerConnection;
  info: McpServerInfo;
  tools: McpToolDescriptor[];
  prompts: McpPromptDescriptor[];
  resources: McpResourceDescriptor[];
  resourceTemplates: McpResourceTemplateDescriptor[];
}

/** Signals a recoverable credential state without confusing it with an unreachable server. */
export class McpReauthorizationRequiredError extends Error {
  constructor(
    readonly serverId: string,
    readonly resourceMetadataUrl: string,
    serverName: string,
    readonly scopes: string[] = [],
  ) {
    super(`${serverName} needs you to sign in again from Connections before its tools can run.`);
    this.name = 'McpReauthorizationRequiredError';
  }
}

export function mcpReauthorizationError(
  server: McpServerConnection,
  error: unknown,
): McpReauthorizationRequiredError | null {
  if (error instanceof McpReauthorizationRequiredError) return error;
  if (mcpAuthKind(server) !== 'oauth' || !server.oauth) return null;
  if (!(error instanceof McpAuthorizationError) && !(error instanceof McpOAuthTokenError)) {
    return null;
  }
  return new McpReauthorizationRequiredError(
    server.id,
    error instanceof McpAuthorizationError && error.resourceMetadataUrl
      ? error.resourceMetadataUrl
      : server.oauth.resourceMetadataUrl,
    server.name,
    error instanceof McpAuthorizationError ? error.scopes : [],
  );
}

function throwMcpConnectionError(server: McpServerConnection, error: unknown): never {
  throw mcpReauthorizationError(server, error) ?? error;
}

/**
 * Returns the bearer value for a connection. An OAuth token that is about to expire is refreshed
 * first, so a stale token never reaches the server as a mysterious 401.
 */
async function bearerFor(server: McpServerConnection): Promise<string | undefined> {
  if (!server.hasToken) return undefined;
  if (mcpAuthKind(server) !== 'oauth' || !server.oauth) {
    return (await loadMcpToken(server.id)) ?? undefined;
  }
  const credentials = await loadMcpOAuthCredentials(server.id);
  if (!credentials) {
    throw new McpReauthorizationRequiredError(
      server.id,
      server.oauth.resourceMetadataUrl,
      server.name,
    );
  }
  const { tokens } = credentials;
  if (tokensAreFresh(tokens, Date.now())) return tokens.accessToken;
  if (!tokens.refreshToken) {
    throw new McpReauthorizationRequiredError(
      server.id,
      server.oauth.resourceMetadataUrl,
      server.name,
    );
  }
  let refreshed: McpOAuthTokens;
  try {
    refreshed = await refreshTokens(
      bindingMetadata(server.oauth),
      {
        clientId: server.oauth.clientId,
        ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
      },
      tokens,
      server.oauth.resource,
    );
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
  await saveMcpOAuthCredentials(server.id, refreshed, credentials.clientSecret);
  return refreshed.accessToken;
}

export async function configureMcpSampling(
  serverId: string,
  providerId: string,
  model: string,
): Promise<void> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP connection no longer exists.');
  const provider = loadProviderConfigs().find((candidate) => candidate.id === providerId);
  if (!provider || !provider.enabled) throw new Error('Choose an enabled model provider first.');
  if (!model.trim()) throw new Error('Choose a model for MCP sampling.');
  if (provider.availableModels?.length && !provider.availableModels.includes(model.trim())) {
    throw new Error('The selected sampling model is no longer reported by this provider.');
  }
  await mcpServerRepository.save({
    ...server,
    samplingProviderId: provider.id,
    samplingModel: model.trim(),
  });
  notifyMcpChanged();
}

async function sampleFromConfiguredProvider(
  server: McpServerConnection,
  request: import('@iris/mcp').McpSamplingRequest,
  signal: AbortSignal,
): Promise<import('@iris/mcp').McpSamplingResponse> {
  if (!server.samplingProviderId || !server.samplingModel) {
    throw new Error('Choose a sampling provider and model for this MCP connection first.');
  }
  const config = loadProviderConfigs().find(
    (candidate) => candidate.id === server.samplingProviderId,
  );
  if (!config || !config.enabled)
    throw new Error('The configured sampling provider is unavailable.');
  const storedSecrets = await loadProviderSecrets(config.id);
  const connected = {
    ...config,
    connectionValues: {
      ...(storedSecrets ?? {}),
      ...(config.connectionValues ?? {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    },
  };
  const missing = missingProviderConnectionFields({ ...connected, storedSecretFields: [] });
  if (missing.length) {
    throw new Error(
      `The sampling provider needs ${missing.map((field) => field.label.toLowerCase()).join(' and ')}.`,
    );
  }
  const provider = createModelProvider(connected);
  const messages: ModelMessage[] = [
    ...(request.systemPrompt ? [{ role: 'system' as const, content: request.systemPrompt }] : []),
    ...request.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  let content = '';
  let sawToolCall = false;
  for await (const chunk of provider.stream(
    {
      model: server.samplingModel,
      messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      stopSequences: request.stopSequences,
    },
    signal,
  )) {
    if (chunk.toolCalls?.length) sawToolCall = true;
    content += chunk.text;
    if (chunk.done) break;
  }
  if (sawToolCall) throw new Error('MCP sampling providers must return text, not tool calls.');
  return {
    model: server.samplingModel,
    role: 'assistant',
    content,
    stopReason: content ? 'endTurn' : 'error',
  };
}

function bindingMetadata(binding: McpOAuthBinding) {
  return {
    issuer: binding.issuer,
    authorizationEndpoint: binding.authorizationEndpoint,
    tokenEndpoint: binding.tokenEndpoint,
    ...(binding.registrationEndpoint ? { registrationEndpoint: binding.registrationEndpoint } : {}),
    scopesSupported: binding.scopes,
    supportsPkce: true,
  };
}

async function clientFor(server: McpServerConnection): Promise<McpClient> {
  const client =
    server.transport === 'stdio'
      ? (() => {
          if (!server.stdio)
            throw new Error('This local stdio MCP connection has no valid command configuration.');
          return new McpClient(server.url, new NativeStdioMcpTransport(server.stdio));
        })()
      : new McpClient(server.url, mcpTransport, await bearerFor(server));
  client.setServerRequestHandler(async (request, signal) => {
    if (!isSupportedMcpServerRequestMethod(request.method)) {
      return {
        status: 'deny',
        code: -32601,
        message: `IRIS does not support server request ${request.method}.`,
      };
    }
    const policy = await mcpServerRequestPolicyRepository.get(server.id, request.method);
    if (!policy || policy.decision !== 'allow') {
      return {
        status: 'deny',
        code: -32601,
        message: `IRIS denied ${request.method}; allow it in Connections first.`,
      };
    }
    if (request.method === 'elicitation/create') {
      try {
        return { status: 'allow', result: await requestElicitation(server, request, signal) };
      } catch (error) {
        return {
          status: 'deny',
          code: -32800,
          message: error instanceof Error ? error.message : 'Elicitation cancelled.',
        };
      }
    }
    if (request.method === 'sampling/createMessage') {
      const parsed = parseMcpSamplingRequest(request.params);
      if (!parsed) {
        return {
          status: 'deny',
          code: -32602,
          message: 'IRIS supports only bounded text sampling requests.',
        };
      }
      try {
        return {
          status: 'allow',
          result: await sampleFromConfiguredProvider(server, parsed, signal),
        };
      } catch (error) {
        return {
          status: 'deny',
          code: -32000,
          message: error instanceof Error ? error.message : 'Sampling failed.',
        };
      }
    }
    const mount = await workspaceRepository.get();
    return {
      status: 'allow',
      result: {
        roots: mount ? [{ uri: encodeURI(`file://${mount.rootPath}`), name: mount.name }] : [],
      },
    };
  });
  return client;
}

export async function listMcpServerRequestPolicies(serverId: string) {
  return (await mcpServerRequestPolicyRepository.list()).filter(
    (policy) => policy.serverId === serverId,
  );
}

export async function setMcpServerRequestPolicy(
  serverId: string,
  method: SupportedMcpServerRequestMethod,
  decision: McpServerRequestPolicyDecision | '',
): Promise<void> {
  if (!isSupportedMcpServerRequestMethod(method))
    throw new Error('Unsupported MCP server request method.');
  if (!decision) return mcpServerRequestPolicyRepository.remove(serverId, method);
  await mcpServerRequestPolicyRepository.save({
    version: 1,
    id: `mcp-request:${serverId}:${method}`,
    serverId,
    method,
    decision,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * A discovered tool is registered as an external write risk and stays deny-by-default: it still has
 * to be assigned to an agent and given an explicit Ask, Allow or Deny decision before it can run.
 */
function registerServerTools(server: McpServerConnection, tools: McpToolDescriptor[]): void {
  toolRegistry.unregisterWhere((tool) => tool.id.startsWith(`mcp.${server.id}.`));
  for (const tool of tools) {
    const registered: RegisteredTool = {
      id: mcpToolId(server.id, tool.name),
      name: `${server.name}: ${tool.name}`,
      description: tool.description,
      risk: 'external',
      inputSchema: tool.inputSchema,
      providerName: `mcp_${server.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      async run(input) {
        let client: McpClient | undefined;
        try {
          client = await clientFor(server);
          const result = await client.callTool(tool.name, input);
          if (result.isError) {
            throw new Error(`${server.name} reported a tool error: ${result.text}`);
          }
          return result.text;
        } catch (error) {
          throwMcpConnectionError(server, error);
        } finally {
          await client?.close();
        }
      },
    };
    toolRegistry.replace(registered);
  }
}

export function unregisterServerTools(serverId: string): string[] {
  return toolRegistry.unregisterWhere((tool) => tool.id.startsWith(`mcp.${serverId}.`));
}

export async function listMcpServers(): Promise<McpServerConnection[]> {
  return (await mcpServerRepository.list()).map(cloneMcpServer);
}

export interface McpServerDraft {
  name: string;
  url: string;
  token?: string;
  catalogSlug?: string;
}

export interface McpStdioServerDraft {
  name: string;
  configuration: McpStdioConfiguration;
}

/** Adds a user-explicit local process connection; its discovered tools retain normal permission gates. */
export async function addStdioMcpServer(
  draft: McpStdioServerDraft,
  now: () => Date = () => new Date(),
): Promise<McpConnectionResult> {
  const name = requireMcpServerName(draft.name);
  const id = `mcp-${crypto.randomUUID()}`;
  const url = `stdio://local/${id}`;
  const existing = await mcpServerRepository.list();
  if (
    existing.some(
      (server) =>
        server.transport === 'stdio' &&
        JSON.stringify(server.stdio) === JSON.stringify(draft.configuration),
    )
  ) {
    throw new Error('That local MCP command is already connected.');
  }
  const client = new McpClient(url, new NativeStdioMcpTransport(draft.configuration));
  let info: McpServerInfo;
  let tools: McpToolDescriptor[];
  let prompts: McpPromptDescriptor[];
  let resources: McpResourceDescriptor[];
  let resourceTemplates: McpResourceTemplateDescriptor[];
  try {
    info = await client.initialize();
    tools = await client.listTools();
    prompts = await client.listPrompts();
    resources = await client.listResources();
    resourceTemplates = await client.listResourceTemplates();
  } finally {
    await client.close();
  }
  const timestamp = now().toISOString();
  const server: McpServerConnection = {
    version: 1,
    id,
    name,
    url,
    transport: 'stdio',
    stdio: draft.configuration,
    hasToken: false,
    auth: 'none',
    createdAt: timestamp,
    verifiedAt: timestamp,
  };
  await mcpServerRepository.save(server);
  registerServerTools(server, tools);
  notifyMcpChanged();
  return { server, info, tools, prompts, resources, resourceTemplates };
}

/**
 * Adding a server connects to it immediately. Nothing is stored unless the handshake really
 * succeeded, so a saved connection always means IRIS reached that server at least once.
 */
export async function addMcpServer(
  draft: McpServerDraft,
  now: () => Date = () => new Date(),
): Promise<McpConnectionResult> {
  const name = requireMcpServerName(draft.name);
  const url = requireMcpServerUrl(draft.url);
  const existing = await mcpServerRepository.list();
  if (existing.some((server) => server.url === url)) {
    throw new Error('That MCP server is already connected.');
  }
  const id = `mcp-${crypto.randomUUID()}`;
  const token = draft.token?.trim();
  const client = new McpClient(url, mcpTransport, token || undefined);
  const info = await client.initialize();
  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  const resources = await client.listResources();
  const resourceTemplates = await client.listResourceTemplates();

  if (token) await saveMcpToken(id, token);
  const timestamp = now().toISOString();
  const server: McpServerConnection = {
    version: 1,
    id,
    name,
    url,
    hasToken: Boolean(token),
    auth: token ? 'token' : 'none',
    createdAt: timestamp,
    verifiedAt: timestamp,
    ...(draft.catalogSlug ? { catalogSlug: draft.catalogSlug } : {}),
  };
  await mcpServerRepository.save(server);
  registerServerTools(server, tools);
  notifyMcpChanged();
  return { server, info, tools, prompts, resources, resourceTemplates };
}

/**
 * Connects, and when the server answers with an OAuth challenge instead, reports that a sign-in is
 * possible rather than failing. Nothing is stored until a real handshake succeeds.
 */
export async function probeMcpServer(
  url: string,
  token?: string,
): Promise<
  | {
      status: 'connected';
      info: McpServerInfo;
      tools: McpToolDescriptor[];
      prompts: McpPromptDescriptor[];
      resources: McpResourceDescriptor[];
      resourceTemplates: McpResourceTemplateDescriptor[];
    }
  | { status: 'sign-in-required'; resourceMetadataUrl: string; scopes: string[] }
> {
  const serverUrl = requireMcpServerUrl(url);
  const client = new McpClient(serverUrl, mcpTransport, token || undefined);
  try {
    const info = await client.initialize();
    return {
      status: 'connected',
      info,
      tools: await client.listTools(),
      prompts: await client.listPrompts(),
      resources: await client.listResources(),
      resourceTemplates: await client.listResourceTemplates(),
    };
  } catch (error) {
    if (error instanceof McpAuthorizationError && error.status === 401) {
      return {
        status: 'sign-in-required',
        resourceMetadataUrl: protectedResourceMetadataUrls(
          serverUrl,
          error.resourceMetadataUrl,
        )[0]!,
        scopes: error.scopes,
      };
    }
    throw error;
  }
}

/**
 * Completes an interactive sign-in and stores the connection only once the issued token really
 * works against the server.
 */
export async function signInAndConnect(
  draft: McpServerDraft,
  resourceMetadataUrl: string,
  requestedScopes: string[] = [],
  onStatus: (message: string) => void = () => undefined,
  now: () => Date = () => new Date(),
  configuredClient?: McpOAuthClient,
): Promise<McpConnectionResult> {
  const name = requireMcpServerName(draft.name);
  const url = requireMcpServerUrl(draft.url);
  const existing = await mcpServerRepository.list();
  if (existing.some((server) => server.url === url)) {
    throw new Error('That MCP server is already connected.');
  }

  const result: McpSignInResult = await signIn(
    resourceMetadataUrl,
    onStatus,
    url,
    requestedScopes,
    configuredClient,
  );
  onStatus('Verifying the new credentials against the server…');
  const client = new McpClient(url, mcpTransport, result.tokens.accessToken);
  const info = await client.initialize();
  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  const resources = await client.listResources();
  const resourceTemplates = await client.listResourceTemplates();

  const id = `mcp-${crypto.randomUUID()}`;
  await saveMcpOAuthCredentials(id, result.tokens, result.client.clientSecret);
  const timestamp = now().toISOString();
  const server: McpServerConnection = {
    version: 1,
    id,
    name,
    url,
    hasToken: true,
    auth: 'oauth',
    oauth: {
      resourceMetadataUrl: result.discovery.resourceMetadataUrl,
      resource: result.discovery.resource,
      issuer: result.discovery.metadata.issuer,
      authorizationEndpoint: result.discovery.metadata.authorizationEndpoint,
      tokenEndpoint: result.discovery.metadata.tokenEndpoint,
      ...(result.discovery.metadata.registrationEndpoint
        ? { registrationEndpoint: result.discovery.metadata.registrationEndpoint }
        : {}),
      clientId: result.client.clientId,
      scopes: result.discovery.scopes,
      signedInAt: timestamp,
    },
    createdAt: timestamp,
    verifiedAt: timestamp,
    ...(draft.catalogSlug ? { catalogSlug: draft.catalogSlug } : {}),
  };
  await mcpServerRepository.save(server);
  registerServerTools(server, tools);
  notifyMcpChanged();
  return { server, info, tools, prompts, resources, resourceTemplates };
}

export async function refreshMcpServer(
  serverId: string,
  now: () => Date = () => new Date(),
): Promise<McpConnectionResult> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  let info: McpServerInfo;
  let tools: McpToolDescriptor[];
  let prompts: McpPromptDescriptor[];
  let resources: McpResourceDescriptor[];
  let resourceTemplates: McpResourceTemplateDescriptor[];
  try {
    const client = await clientFor(server);
    info = await client.initialize();
    tools = await client.listTools();
    prompts = await client.listPrompts();
    resources = await client.listResources();
    resourceTemplates = await client.listResourceTemplates();
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
  const verified: McpServerConnection = { ...server, verifiedAt: now().toISOString() };
  await mcpServerRepository.save(verified);
  registerServerTools(verified, tools);
  notifyMcpChanged();
  return { server: verified, info, tools, prompts, resources, resourceTemplates };
}

/** Runs a fresh browser sign-in for an existing OAuth connection and replaces its keyring tokens. */
export async function reauthorizeMcpServer(
  serverId: string,
  resourceMetadataUrl?: string,
  requestedScopes: string[] = [],
  onStatus: (message: string) => void = () => undefined,
  now: () => Date = () => new Date(),
): Promise<McpConnectionResult> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  if (mcpAuthKind(server) !== 'oauth' || !server.oauth) {
    throw new Error('Only an OAuth connection can be signed in again.');
  }

  const metadataUrl = resourceMetadataUrl?.trim() || server.oauth.resourceMetadataUrl;
  const result = await signIn(metadataUrl, onStatus, server.url, requestedScopes);
  onStatus('Verifying the new credentials against the server…');
  const client = new McpClient(server.url, mcpTransport, result.tokens.accessToken);
  const info = await client.initialize();
  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  const resources = await client.listResources();
  const resourceTemplates = await client.listResourceTemplates();

  const timestamp = now().toISOString();
  const verified: McpServerConnection = {
    ...server,
    hasToken: true,
    auth: 'oauth',
    oauth: {
      resourceMetadataUrl: result.discovery.resourceMetadataUrl,
      resource: result.discovery.resource,
      issuer: result.discovery.metadata.issuer,
      authorizationEndpoint: result.discovery.metadata.authorizationEndpoint,
      tokenEndpoint: result.discovery.metadata.tokenEndpoint,
      ...(result.discovery.metadata.registrationEndpoint
        ? { registrationEndpoint: result.discovery.metadata.registrationEndpoint }
        : {}),
      clientId: result.client.clientId,
      scopes: result.discovery.scopes,
      signedInAt: timestamp,
    },
    verifiedAt: timestamp,
  };
  await saveMcpOAuthCredentials(server.id, result.tokens, result.client.clientSecret);
  await mcpServerRepository.save(verified);
  registerServerTools(verified, tools);
  notifyMcpChanged();
  return { server: verified, info, tools, prompts, resources, resourceTemplates };
}

export async function getMcpPrompt(
  serverId: string,
  name: string,
  args: Record<string, string> = {},
): Promise<McpPromptResult> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  try {
    return await (await clientFor(server)).getPrompt(name, args);
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
}

export async function completeMcp(
  serverId: string,
  request: McpCompletionRequest,
): Promise<McpCompletionResult> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  try {
    return await (await clientFor(server)).complete(request);
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
}

export async function listMcpPrompts(serverId: string): Promise<McpPromptDescriptor[]> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  try {
    return await (await clientFor(server)).listPrompts();
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
}

export async function listMcpResources(serverId: string): Promise<McpResourceDescriptor[]> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  try {
    return await (await clientFor(server)).listResources();
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
}

export async function listMcpResourceTemplates(
  serverId: string,
): Promise<McpResourceTemplateDescriptor[]> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  try {
    return await (await clientFor(server)).listResourceTemplates();
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
}

export async function readMcpResource(
  serverId: string,
  uri: string,
): Promise<McpResourceReadResult> {
  const server = await mcpServerRepository.get(serverId);
  if (!server) throw new Error('That MCP server is no longer configured.');
  try {
    return await (await clientFor(server)).readResource(uri);
  } catch (error) {
    throwMcpConnectionError(server, error);
  }
}

export async function removeMcpServer(serverId: string): Promise<void> {
  unregisterServerTools(serverId);
  await deleteMcpToken(serverId);
  await mcpServerRepository.remove(serverId);
  notifyMcpChanged();
}

/**
 * Stored connections expose no tools until they are reached again, so a server that has gone away
 * cannot leave a phantom tool behind for an agent to call.
 */
export async function restoreMcpServers(): Promise<void> {
  const servers = await mcpServerRepository.list();
  await Promise.all(
    servers.map(async (server) => {
      try {
        const client = await clientFor(server);
        registerServerTools(server, await client.listTools());
      } catch {
        unregisterServerTools(server.id);
      }
    }),
  );
  notifyMcpChanged();
}

export function registeredMcpToolIds(serverId: string): string[] {
  return toolRegistry
    .list()
    .filter((tool) => tool.id.startsWith(`mcp.${serverId}.`))
    .map((tool) => tool.id);
}
