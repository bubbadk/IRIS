export const mcpProtocolVersion = '2025-06-18';

export const mcpNameLimit = 60;
export const mcpToolLimit = 200;
export const mcpPromptLimit = 200;
export const mcpPromptMessageLimit = 50;
export const mcpResourceLimit = 200;
export const mcpResourceTemplateLimit = 200;
export const mcpResourceContentLimit = 50;
export const mcpResourceTextLimit = 100_000;
export const mcpCompletionValueLimit = 100;
export const mcpCompletionTextLimit = 2_000;
export const mcpStdioCommandLimit = 240;
export const mcpStdioArgumentLimit = 100;
export const mcpStdioArgumentLengthLimit = 2_000;
export const mcpStdioEnvironmentLimit = 64;
export const mcpStdioEnvironmentValueLimit = 2_000;
export const mcpServerRequestTimeoutMs = 30_000;
export const mcpElicitationFieldLimit = 20;
export const mcpElicitationTextLimit = 2_000;
export const mcpSamplingMessageLimit = 20;
export const mcpSamplingTextLimit = 12_000;
export const mcpSamplingMaxTokens = 4_096;

/** Server-to-client methods IRIS can currently answer with real local state. */
export const supportedMcpServerRequestMethods = [
  'roots/list',
  'elicitation/create',
  'sampling/createMessage',
] as const;
export type SupportedMcpServerRequestMethod = (typeof supportedMcpServerRequestMethods)[number];

export function isSupportedMcpServerRequestMethod(
  method: string,
): method is SupportedMcpServerRequestMethod {
  return (supportedMcpServerRequestMethods as readonly string[]).includes(method);
}

export type McpAuthKind = 'none' | 'token' | 'oauth';

/** Explicit local-process configuration. It is data only; the native host owns execution. */
export interface McpStdioConfiguration {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function validStdioString(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !value.includes('\u0000') &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

export function validateMcpStdioConfiguration(value: unknown): value is McpStdioConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (!validStdioString(config.command, mcpStdioCommandLimit)) return false;
  if (
    !Array.isArray(config.args) ||
    config.args.length > mcpStdioArgumentLimit ||
    !config.args.every((arg) => validStdioString(arg, mcpStdioArgumentLengthLimit))
  )
    return false;
  if (config.env === undefined) return true;
  if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) return false;
  const entries = Object.entries(config.env);
  return (
    entries.length <= mcpStdioEnvironmentLimit &&
    entries.every(
      ([key, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        validStdioString(entry, mcpStdioEnvironmentValueLimit),
    )
  );
}

export function cloneMcpStdioConfiguration(config: McpStdioConfiguration): McpStdioConfiguration {
  return {
    command: config.command,
    args: [...config.args],
    ...(config.env ? { env: { ...config.env } } : {}),
  };
}

/** Non-secret OAuth state. The tokens themselves live in the OS keyring, never here. */
export interface McpOAuthBinding {
  resourceMetadataUrl: string;
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientId: string;
  scopes: string[];
  signedInAt: string;
}

export interface McpServerConnection {
  version: 1;
  id: string;
  name: string;
  url: string;
  /** Absent records are HTTP connections written before local stdio support. */
  transport?: 'http' | 'stdio';
  /** Local command data; only meaningful for an explicitly selected stdio transport. */
  stdio?: McpStdioConfiguration;
  /** True when a credential for this server exists in the OS keyring. */
  hasToken: boolean;
  /** How this connection authenticates; absent on records written before sign-in existed. */
  auth?: McpAuthKind;
  oauth?: McpOAuthBinding;
  createdAt: string;
  verifiedAt: string | null;
  /** Set from the directory when the server was discovered rather than typed by hand. */
  catalogSlug?: string;
  /** Optional explicit model authority for server-initiated sampling. */
  samplingProviderId?: string;
  samplingModel?: string;
}

export function mcpAuthKind(server: McpServerConnection): McpAuthKind {
  if (server.auth) return server.auth;
  return server.hasToken ? 'token' : 'none';
}

export interface McpServerRepository {
  list(): Promise<McpServerConnection[]>;
  get(id: string): Promise<McpServerConnection | null>;
  save(server: McpServerConnection): Promise<void>;
  remove(id: string): Promise<void>;
}

export function cloneMcpServer(server: McpServerConnection): McpServerConnection {
  return {
    ...server,
    ...(server.stdio ? { stdio: cloneMcpStdioConfiguration(server.stdio) } : {}),
    ...(server.oauth ? { oauth: { ...server.oauth, scopes: [...server.oauth.scopes] } } : {}),
  };
}

function validateOAuthBinding(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.resourceMetadataUrl === 'string' &&
    typeof binding.resource === 'string' &&
    typeof binding.issuer === 'string' &&
    typeof binding.authorizationEndpoint === 'string' &&
    typeof binding.tokenEndpoint === 'string' &&
    typeof binding.clientId === 'string' &&
    Boolean((binding.clientId as string).trim()) &&
    Array.isArray(binding.scopes) &&
    typeof binding.signedInAt === 'string'
  );
}

export function validateMcpServer(value: unknown): value is McpServerConnection {
  if (!value || typeof value !== 'object') return false;
  const server = value as Partial<McpServerConnection>;
  return (
    server.version === 1 &&
    typeof server.id === 'string' &&
    Boolean(server.id.trim()) &&
    typeof server.name === 'string' &&
    Boolean(server.name.trim()) &&
    typeof server.url === 'string' &&
    Boolean(server.url.trim()) &&
    (server.transport === undefined ||
      server.transport === 'http' ||
      server.transport === 'stdio') &&
    (server.transport !== 'stdio' || validateMcpStdioConfiguration(server.stdio)) &&
    (server.transport === 'stdio' || server.stdio === undefined) &&
    typeof server.hasToken === 'boolean' &&
    (server.auth === undefined ||
      server.auth === 'none' ||
      server.auth === 'token' ||
      server.auth === 'oauth') &&
    validateOAuthBinding(server.oauth) &&
    typeof server.createdAt === 'string' &&
    Boolean(server.createdAt) &&
    (server.verifiedAt === null || typeof server.verifiedAt === 'string') &&
    (server.catalogSlug === undefined || typeof server.catalogSlug === 'string') &&
    (server.samplingProviderId === undefined || typeof server.samplingProviderId === 'string') &&
    (server.samplingModel === undefined || typeof server.samplingModel === 'string')
  );
}

/**
 * A server address is typed by the user, so it is checked here rather than trusted. Plain HTTP is
 * accepted only for loopback, where there is no network to intercept.
 */
export function requireMcpServerUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('An MCP server needs an address.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('That MCP server address is not a valid URL.');
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('An MCP server must use HTTPS, or HTTP only on localhost.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Put credentials in the token field, not in the server address.');
  }
  return parsed.toString();
}

export function requireMcpServerName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('An MCP server needs a name.');
  const name = value.trim();
  if (name.length > mcpNameLimit) {
    throw new Error(`An MCP server name is limited to ${mcpNameLimit} characters.`);
  }
  return name;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface McpServerRequestProvenance {
  serverUrl: string;
  sessionId?: string;
  method: string;
  requestId: number | string;
}

export interface McpServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
  provenance: McpServerRequestProvenance;
}

export type McpElicitationFieldType = 'string' | 'number' | 'boolean';

export interface McpElicitationField {
  name: string;
  title: string;
  type: McpElicitationFieldType;
  required: boolean;
  description?: string;
  enum?: string[];
}

export interface McpElicitationRequest {
  mode: 'form';
  message: string;
  fields: McpElicitationField[];
}

export type McpElicitationAction = 'accept' | 'decline' | 'cancel';

export interface McpElicitationResponse {
  action: McpElicitationAction;
  content?: Record<string, string | number | boolean>;
}

export interface McpSamplingMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface McpSamplingRequest {
  messages: McpSamplingMessage[];
  systemPrompt?: string;
  modelPreferences?: { hints: string[] };
  temperature?: number;
  maxTokens: number;
  stopSequences: string[];
}

export interface McpSamplingResponse {
  model: string;
  role: 'assistant';
  content: string;
  stopReason: 'endTurn' | 'stopSequence' | 'maxTokens' | 'error';
}

export type McpServerRequestDecision =
  { status: 'allow'; result: unknown } | { status: 'deny'; code?: number; message?: string };

export type McpServerRequestHandler = (
  request: McpServerRequest,
  signal: AbortSignal,
) => Promise<McpServerRequestDecision>;

/** Accepts only the bounded form subset IRIS can render and validate interactively. */
export function parseMcpElicitationRequest(params: unknown): McpElicitationRequest | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const value = params as Record<string, unknown>;
  if (value.mode !== 'form' || typeof value.message !== 'string' || !value.message.trim())
    return null;
  if (
    value.message.length > mcpElicitationTextLimit ||
    !value.requestedSchema ||
    typeof value.requestedSchema !== 'object' ||
    Array.isArray(value.requestedSchema)
  )
    return null;
  const schema = value.requestedSchema as Record<string, unknown>;
  if (
    schema.type !== 'object' ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  )
    return null;
  if (Object.keys(schema.properties).length > mcpElicitationFieldLimit) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );
  const fields = Object.entries(schema.properties)
    .slice(0, mcpElicitationFieldLimit)
    .flatMap(([name, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const property = raw as Record<string, unknown>;
      const type = property.type;
      if (type !== 'string' && type !== 'number' && type !== 'boolean') return [];
      const fieldType = type as McpElicitationFieldType;
      const enumValues =
        Array.isArray(property.enum) && property.enum.every((item) => typeof item === 'string')
          ? (property.enum.slice(0, 20) as string[])
          : undefined;
      return [
        {
          name,
          title:
            typeof property.title === 'string' && property.title.trim()
              ? property.title.trim()
              : name,
          type: fieldType,
          required: required.has(name),
          ...(typeof property.description === 'string' && property.description.trim()
            ? { description: property.description.trim().slice(0, mcpElicitationTextLimit) }
            : {}),
          ...(enumValues?.length ? { enum: enumValues } : {}),
        },
      ];
    });
  if (
    !fields.length ||
    fields.length !== Object.keys(schema.properties).slice(0, mcpElicitationFieldLimit).length
  )
    return null;
  return { mode: 'form', message: value.message.trim(), fields };
}

/** Accepts only text sampling requests with bounded context and generation limits. */
export function parseMcpSamplingRequest(params: unknown): McpSamplingRequest | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const value = params as Record<string, unknown>;
  if (!Array.isArray(value.messages) || !value.messages.length) return null;
  if (
    value.systemPrompt !== undefined &&
    (typeof value.systemPrompt !== 'string' || value.systemPrompt.length > mcpSamplingTextLimit)
  )
    return null;
  if (value.messages.length > mcpSamplingMessageLimit) return null;
  const messages = value.messages.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content = message.content;
    if (typeof content !== 'string' || !content.trim() || content.length > mcpSamplingTextLimit)
      return [];
    return [{ role: message.role as 'user' | 'assistant', content }];
  });
  if (messages.length !== value.messages.length) return null;
  const maxTokens = value.maxTokens;
  if (
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > mcpSamplingMaxTokens
  )
    return null;
  const temperature = value.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  )
    return null;
  const stopSequences = Array.isArray(value.stopSequences)
    ? value.stopSequences.filter(
        (item): item is string => typeof item === 'string' && item.length <= 200,
      )
    : [];
  if (Array.isArray(value.stopSequences) && stopSequences.length !== value.stopSequences.length)
    return null;
  const hints =
    value.modelPreferences && typeof value.modelPreferences === 'object'
      ? (value.modelPreferences as Record<string, unknown>).hints
      : undefined;
  if (
    hints !== undefined &&
    (!Array.isArray(hints) || hints.some((hint) => typeof hint !== 'string'))
  )
    return null;
  return {
    messages,
    ...(typeof value.systemPrompt === 'string' ? { systemPrompt: value.systemPrompt } : {}),
    ...(hints ? { modelPreferences: { hints: hints.slice(0, 10) } } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    maxTokens,
    stopSequences,
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface McpTransportResponse {
  status: number;
  contentType: string;
  sessionId?: string;
  /** The `WWW-Authenticate` header, which is where an OAuth challenge names its metadata document. */
  authenticate?: string;
  /** Present when a redirect was deliberately not followed by the native security boundary. */
  location?: string;
  body: string;
}

export interface McpTransportRequest {
  url: string;
  payload: string;
  token?: string;
  sessionId?: string;
}

export interface McpTransport {
  send(request: McpTransportRequest, signal?: AbortSignal): Promise<McpTransportResponse>;
  close?(sessionId?: string): Promise<void>;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerInfo {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description: string;
  arguments: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface McpPromptResult {
  description: string;
  messages: McpPromptMessage[];
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  title?: string;
  description: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  title?: string;
  description: string;
  mimeType?: string;
}

export type McpCompletionReference =
  { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };

export interface McpCompletionRequest {
  ref: McpCompletionReference;
  argument: { name: string; value: string };
}

export interface McpCompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContent[];
}

/**
 * Streamable HTTP servers may answer a JSON-RPC request either as a single JSON body or as an SSE
 * stream carrying the same message, so both shapes are read back into one envelope.
 */
export function parseJsonRpcMessages(response: McpTransportResponse): unknown[] {
  const body = response.body.trim();
  if (!body) throw new Error('The MCP server returned an empty response.');
  const candidates: unknown[] = [];
  if (response.contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!data || data === '[DONE]') continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        continue;
      }
    }
    if (!candidates.length) {
      throw new Error('The MCP server returned an event stream with no readable message.');
    }
  } else {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      throw new Error('The MCP server returned a response that is not JSON.');
    }
  }

  return candidates;
}

export function parseJsonRpcBody(response: McpTransportResponse, id: number | string): unknown {
  const candidates = parseJsonRpcMessages(response);
  const message =
    candidates.find(
      (candidate) =>
        candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === id,
    ) ?? candidates[candidates.length - 1];
  if (!message || typeof message !== 'object') {
    throw new Error('The MCP server returned an unreadable JSON-RPC message.');
  }
  const envelope = message as { error?: unknown; result?: unknown };
  if (envelope.error) {
    const error = envelope.error as { message?: unknown; code?: unknown };
    const detail = typeof error.message === 'string' ? error.message : 'Unknown MCP error.';
    const code = typeof error.code === 'number' ? ` (code ${error.code})` : '';
    throw new Error(`The MCP server refused the request: ${detail}${code}`);
  }
  if (!('result' in envelope)) {
    throw new Error('The MCP server returned a JSON-RPC message with no result.');
  }
  return envelope.result;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const block = item as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block.type === 'string') return `[${block.type} content]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function parseMcpTools(result: unknown): McpToolDescriptor[] {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable tool list.');
  }
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    throw new Error('The MCP server returned no tool list.');
  }
  return tools.slice(0, mcpToolLimit).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const tool = item as Record<string, unknown>;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return [];
    const schema =
      tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: 'object', additionalProperties: true };
    return [
      {
        name,
        description:
          typeof tool.description === 'string' && tool.description.trim()
            ? tool.description.trim()
            : `The ${name} tool exposed by this MCP server.`,
        inputSchema: schema,
      },
    ];
  });
}

export function parseMcpPrompts(result: unknown): McpPromptDescriptor[] {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable prompt list.');
  }
  const prompts = (result as { prompts?: unknown }).prompts;
  if (!Array.isArray(prompts)) throw new Error('The MCP server returned no prompt list.');
  return prompts.slice(0, mcpPromptLimit).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const prompt = item as Record<string, unknown>;
    const name = typeof prompt.name === 'string' ? prompt.name.trim() : '';
    if (!name) return [];
    const args = Array.isArray(prompt.arguments)
      ? prompt.arguments.flatMap((argument) => {
          if (!argument || typeof argument !== 'object') return [];
          const value = argument as Record<string, unknown>;
          const argumentName = typeof value.name === 'string' ? value.name.trim() : '';
          if (!argumentName) return [];
          return [
            {
              name: argumentName,
              description: typeof value.description === 'string' ? value.description.trim() : '',
              required: value.required === true,
            },
          ];
        })
      : [];
    return [
      {
        name,
        ...(typeof prompt.title === 'string' && prompt.title.trim()
          ? { title: prompt.title.trim() }
          : {}),
        description:
          typeof prompt.description === 'string' && prompt.description.trim()
            ? prompt.description.trim()
            : `The ${name} prompt exposed by this MCP server.`,
        arguments: args,
      },
    ];
  });
}

export function parseMcpPromptResult(result: unknown): McpPromptResult {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable prompt.');
  }
  const payload = result as Record<string, unknown>;
  if (!Array.isArray(payload.messages))
    throw new Error('The MCP server returned no prompt messages.');
  const messages = payload.messages.slice(0, mcpPromptMessageLimit).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const message = item as Record<string, unknown>;
    const role: McpPromptMessage['role'] | null =
      message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null;
    if (!role) return [];
    const content = message.content;
    const text = textFromContent([content]);
    return text ? [{ role, text }] : [];
  });
  return {
    description: typeof payload.description === 'string' ? payload.description.trim() : '',
    messages,
  };
}

export function parseMcpResources(result: unknown): McpResourceDescriptor[] {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable resource list.');
  }
  const resources = (result as { resources?: unknown }).resources;
  if (!Array.isArray(resources)) throw new Error('The MCP server returned no resource list.');
  return resources.slice(0, mcpResourceLimit).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const resource = item as Record<string, unknown>;
    const uri = typeof resource.uri === 'string' ? resource.uri.trim() : '';
    const name = typeof resource.name === 'string' ? resource.name.trim() : '';
    if (!uri || !name) return [];
    const size =
      typeof resource.size === 'number' && Number.isSafeInteger(resource.size) && resource.size >= 0
        ? resource.size
        : undefined;
    return [
      {
        uri,
        name,
        ...(typeof resource.title === 'string' && resource.title.trim()
          ? { title: resource.title.trim() }
          : {}),
        description:
          typeof resource.description === 'string' && resource.description.trim()
            ? resource.description.trim()
            : `The ${name} resource exposed by this MCP server.`,
        ...(typeof resource.mimeType === 'string' && resource.mimeType.trim()
          ? { mimeType: resource.mimeType.trim() }
          : {}),
        ...(size !== undefined ? { size } : {}),
      },
    ];
  });
}

export function parseMcpResourceTemplates(result: unknown): McpResourceTemplateDescriptor[] {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable resource template list.');
  }
  const templates = (result as { resourceTemplates?: unknown }).resourceTemplates;
  if (!Array.isArray(templates)) {
    throw new Error('The MCP server returned no resource template list.');
  }
  return templates.slice(0, mcpResourceTemplateLimit).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const template = item as Record<string, unknown>;
    const uriTemplate = typeof template.uriTemplate === 'string' ? template.uriTemplate.trim() : '';
    const name = typeof template.name === 'string' ? template.name.trim() : '';
    if (!uriTemplate || !name) return [];
    return [
      {
        uriTemplate,
        name,
        ...(typeof template.title === 'string' && template.title.trim()
          ? { title: template.title.trim() }
          : {}),
        description:
          typeof template.description === 'string' && template.description.trim()
            ? template.description.trim()
            : `The ${name} resource template exposed by this MCP server.`,
        ...(typeof template.mimeType === 'string' && template.mimeType.trim()
          ? { mimeType: template.mimeType.trim() }
          : {}),
      },
    ];
  });
}

export function parseMcpCompletionResult(result: unknown): McpCompletionResult {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable completion result.');
  }
  const completion = (result as Record<string, unknown>).completion;
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
    throw new Error('The MCP server returned no completion values.');
  }
  const payload = completion as Record<string, unknown>;
  if (
    !Array.isArray(payload.values) ||
    payload.values.length > mcpCompletionValueLimit ||
    payload.values.some(
      (value) => typeof value !== 'string' || value.length > mcpCompletionTextLimit,
    )
  ) {
    throw new Error('The MCP server returned invalid or oversized completion values.');
  }
  const total = payload.total;
  if (
    total !== undefined &&
    (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
  ) {
    throw new Error('The MCP server returned an invalid completion total.');
  }
  if (payload.hasMore !== undefined && typeof payload.hasMore !== 'boolean') {
    throw new Error('The MCP server returned an invalid completion continuation flag.');
  }
  return {
    values: payload.values as string[],
    ...(total === undefined ? {} : { total }),
    ...(payload.hasMore === undefined ? {} : { hasMore: payload.hasMore }),
  };
}

export function parseMcpResourceReadResult(result: unknown): McpResourceReadResult {
  if (!result || typeof result !== 'object') {
    throw new Error('The MCP server returned an unreadable resource.');
  }
  const contents = (result as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) throw new Error('The MCP server returned no resource contents.');
  return {
    contents: contents.slice(0, mcpResourceContentLimit).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const content = item as Record<string, unknown>;
      const uri = typeof content.uri === 'string' ? content.uri.trim() : '';
      if (!uri) return [];
      const text =
        typeof content.text === 'string' ? content.text.slice(0, mcpResourceTextLimit) : undefined;
      const blob = typeof content.blob === 'string' ? content.blob : undefined;
      if (text === undefined && blob === undefined) return [];
      return [
        {
          uri,
          ...(typeof content.mimeType === 'string' && content.mimeType.trim()
            ? { mimeType: content.mimeType.trim() }
            : {}),
          ...(text !== undefined ? { text } : {}),
          ...(blob !== undefined ? { blob } : {}),
        },
      ];
    }),
  };
}

/**
 * A 401 from an MCP server is not necessarily a bad token: under the MCP authorization spec it is
 * how a server invites a client to sign in, naming its metadata document in `WWW-Authenticate`.
 */
export class McpAuthorizationError extends Error {
  readonly resourceMetadataUrl: string | null;
  readonly scopes: string[];

  constructor(
    readonly status: number,
    readonly challenge?: string,
  ) {
    const resourceMetadataUrl = parseResourceMetadataUrl(challenge);
    const scopes = parseChallengeScopes(challenge);
    super(
      resourceMetadataUrl
        ? 'This MCP server requires you to sign in.'
        : 'The MCP server rejected the credentials. Check the token for this connection.',
    );
    this.name = 'McpAuthorizationError';
    this.resourceMetadataUrl = resourceMetadataUrl;
    this.scopes = scopes;
  }

  /** True when the server told us where to authorize, so a sign-in can actually be started. */
  get canAuthorize(): boolean {
    return this.resourceMetadataUrl !== null;
  }
}

export function parseResourceMetadataUrl(challenge?: string): string | null {
  if (!challenge) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseChallengeScopes(challenge?: string): string[] {
  if (!challenge) return [];
  const match = /(?:^|,)\s*scope\s*=\s*"([^"]*)"/i.exec(challenge);
  if (!match?.[1]) return [];
  return [
    ...new Set(
      match[1]
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * RFC 9728 discovery first uses a challenge URL when one is usable, then the endpoint-specific
 * well-known URI, then the origin-level fallback. Keeping all candidates also lets IRIS recover
 * from servers that advertise a stale metadata address while publishing the required well-known one.
 */
export function protectedResourceMetadataUrls(
  serverUrl: string,
  challengedUrl?: string | null,
): string[] {
  const server = new URL(serverUrl);
  const endpointPath = server.pathname === '/' ? '' : server.pathname.replace(/\/$/, '');
  const wellKnown = `${server.origin}/.well-known/oauth-protected-resource`;
  const candidates = [
    ...(challengedUrl ? [challengedUrl] : []),
    ...(endpointPath ? [`${wellKnown}${endpointPath}`] : []),
    wellKnown,
  ];
  return [...new Set(candidates)];
}

export interface McpProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export function parseProtectedResourceMetadata(value: unknown): McpProtectedResourceMetadata {
  if (!value || typeof value !== 'object') {
    throw new Error('The MCP server returned unreadable protected resource metadata.');
  }
  const payload = value as Record<string, unknown>;
  const servers = Array.isArray(payload.authorization_servers)
    ? payload.authorization_servers.flatMap((item) => {
        if (typeof item !== 'string' || !item.trim()) return [];
        try {
          const server = new URL(item.trim());
          return server.protocol === 'https:' && !server.username && !server.password
            ? [server.toString()]
            : [];
        } catch {
          return [];
        }
      })
    : [];
  if (!servers.length) {
    throw new Error('The MCP server names no authorization server, so IRIS cannot sign in.');
  }
  return {
    resource: typeof payload.resource === 'string' ? payload.resource : '',
    authorizationServers: servers,
    scopesSupported: Array.isArray(payload.scopes_supported)
      ? payload.scopes_supported.flatMap((item) =>
          typeof item === 'string' && item.trim() ? [item.trim()] : [],
        )
      : [],
  };
}

export interface McpAuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
  supportsPkce: boolean;
}

function requireHttpsEndpoint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`The authorization server publishes no ${label}.`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`The authorization server published an invalid ${label}.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`The authorization server must publish its ${label} over HTTPS.`);
  }
  return url.toString();
}

export function parseAuthorizationServerMetadata(value: unknown): McpAuthorizationServerMetadata {
  if (!value || typeof value !== 'object') {
    throw new Error('The authorization server returned unreadable metadata.');
  }
  const payload = value as Record<string, unknown>;
  const methods = Array.isArray(payload.code_challenge_methods_supported)
    ? payload.code_challenge_methods_supported
    : [];
  return {
    issuer: requireHttpsEndpoint(payload.issuer, 'issuer'),
    authorizationEndpoint: requireHttpsEndpoint(
      payload.authorization_endpoint,
      'authorization endpoint',
    ),
    tokenEndpoint: requireHttpsEndpoint(payload.token_endpoint, 'token endpoint'),
    ...(typeof payload.registration_endpoint === 'string' && payload.registration_endpoint.trim()
      ? {
          registrationEndpoint: requireHttpsEndpoint(
            payload.registration_endpoint,
            'registration endpoint',
          ),
        }
      : {}),
    scopesSupported: Array.isArray(payload.scopes_supported)
      ? payload.scopes_supported.flatMap((item) =>
          typeof item === 'string' && item.trim() ? [item.trim()] : [],
        )
      : [],
    supportsPkce: methods.includes('S256'),
  };
}

/** RFC 8414 puts the well-known segment after the scheme and host, before any issuer path. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  const origin = url.origin;
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${origin}${path}/.well-known/openid-configuration`] : []),
  ];
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
}

export function parseClientRegistration(value: unknown): McpOAuthClient {
  if (!value || typeof value !== 'object') {
    throw new Error('The authorization server returned an unreadable client registration.');
  }
  const payload = value as Record<string, unknown>;
  const clientId = typeof payload.client_id === 'string' ? payload.client_id.trim() : '';
  if (!clientId) {
    throw new Error('The authorization server issued no client id.');
  }
  return {
    clientId,
    ...(typeof payload.client_secret === 'string' && payload.client_secret.trim()
      ? { clientSecret: payload.client_secret.trim() }
      : {}),
  };
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry in epoch milliseconds, absent when the server does not say. */
  expiresAt?: number;
  scope?: string;
}

/** A structured OAuth refusal lets the desktop distinguish revoked consent from a network outage. */
export class McpOAuthTokenError extends Error {
  constructor(
    readonly code: string,
    readonly description?: string,
  ) {
    super(
      `The authorization server refused the token request (${code})${description ? `: ${description}` : ''}`,
    );
    this.name = 'McpOAuthTokenError';
  }
}

export function parseTokenResponse(value: unknown, now: number): McpOAuthTokens {
  if (!value || typeof value !== 'object') {
    throw new Error('The authorization server returned an unreadable token response.');
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.error === 'string') {
    throw new McpOAuthTokenError(
      payload.error,
      typeof payload.error_description === 'string' ? payload.error_description : undefined,
    );
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('The authorization server returned no access token.');
  }
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
      ? { refreshToken: payload.refresh_token.trim() }
      : {}),
    ...(expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: now + Math.floor(expiresIn * 1000) }
      : {}),
    ...(typeof payload.scope === 'string' && payload.scope.trim()
      ? { scope: payload.scope.trim() }
      : {}),
  };
}

/** Refreshed a minute early so a token cannot expire between the check and the request. */
export function tokensAreFresh(tokens: McpOAuthTokens, now: number): boolean {
  if (tokens.expiresAt === undefined) return true;
  return tokens.expiresAt - 60_000 > now;
}

export interface McpAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export function buildAuthorizationUrl(input: {
  metadata: McpAuthorizationServerMetadata;
  client: McpOAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
}): string {
  const url = new URL(input.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.client.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  if (input.metadata.supportsPkce) {
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (input.scopes.length) url.searchParams.set('scope', input.scopes.join(' '));
  // RFC 8707 binds the issued token to this specific MCP server.
  if (input.resource) url.searchParams.set('resource', input.resource);
  return url.toString();
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private initialized = false;
  private serverRequestHandler: McpServerRequestHandler | undefined;

  constructor(
    private readonly url: string,
    private readonly transport: McpTransport,
    private readonly token?: string,
  ) {}

  /**
   * Installs the host's server-request policy. No handler means deny-by-default; MCP server
   * requests never acquire authority merely because a connection exists.
   */
  setServerRequestHandler(handler?: McpServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  private async handleServerRequests(
    response: McpTransportResponse,
    expectedId: number | string,
    signal?: AbortSignal,
  ): Promise<void> {
    const messages = parseJsonRpcMessages(response);
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const request = message as Partial<JsonRpcRequest>;
      if (
        request.jsonrpc !== '2.0' ||
        request.id === undefined ||
        request.id === expectedId ||
        typeof request.method !== 'string' ||
        !request.method.trim()
      ) {
        continue;
      }
      const requestId = request.id;
      const provenance: McpServerRequestProvenance = Object.freeze({
        serverUrl: this.url,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        method: request.method,
        requestId,
      });
      const serverRequest: McpServerRequest = Object.freeze({
        jsonrpc: '2.0',
        id: requestId,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {}),
        provenance,
      });
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      let timeoutReject!: (error: Error) => void;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutReject = reject;
      });
      const timeout = setTimeout(() => {
        controller.abort();
        timeoutReject(new Error('The MCP server request timed out.'));
      }, mcpServerRequestTimeoutMs);
      let reply: { result?: unknown; error?: { code: number; message: string } };
      try {
        const decision = await Promise.race([
          this.serverRequestHandler
            ? this.serverRequestHandler(serverRequest, controller.signal)
            : Promise.resolve({
                status: 'deny' as const,
                code: -32601,
                message: 'Server requests are not enabled.',
              }),
          timeoutPromise,
        ]);
        if (decision.status === 'allow') {
          reply = { result: decision.result };
        } else {
          reply = {
            error: {
              code: decision.code ?? -32600,
              message: decision.message ?? 'IRIS denied this server request.',
            },
          };
        }
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Request failed.';
        reply = { error: { code: -32603, message } };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
      signal?.throwIfAborted();
      await this.transport.send(
        {
          url: this.url,
          payload: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...reply }),
          ...(this.token ? { token: this.token } : {}),
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        },
        signal,
      );
    }
  }

  private async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const response = await this.transport.send(
      {
        url: this.url,
        payload: JSON.stringify(request),
        ...(this.token ? { token: this.token } : {}),
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
      signal,
    );
    if (response.sessionId) this.sessionId = response.sessionId;
    if (response.status === 401 || response.status === 403) {
      throw new McpAuthorizationError(response.status, response.authenticate);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        response.location
          ? `The MCP server redirected outside its configured origin to ${response.location}; IRIS refused to forward credentials there.`
          : `The MCP server returned an unsupported HTTP redirect (${response.status}).`,
      );
    }
    if (response.status >= 400) {
      throw new Error(`The MCP server answered HTTP ${response.status}.`);
    }
    await this.handleServerRequests(response, id, signal);
    return parseJsonRpcBody(response, id);
  }

  private async notify(method: string, signal?: AbortSignal): Promise<void> {
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method };
    await this.transport.send(
      {
        url: this.url,
        payload: JSON.stringify(notification),
        ...(this.token ? { token: this.token } : {}),
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
      signal,
    );
  }

  async initialize(clientName = 'IRIS', signal?: AbortSignal): Promise<McpServerInfo> {
    const result = await this.call(
      'initialize',
      {
        protocolVersion: mcpProtocolVersion,
        capabilities: { sampling: {} },
        clientInfo: { name: clientName, version: '0.1.0' },
      },
      signal,
    );
    if (!result || typeof result !== 'object') {
      throw new Error('The MCP server returned an unreadable initialize result.');
    }
    const payload = result as Record<string, unknown>;
    const info = (
      payload.serverInfo && typeof payload.serverInfo === 'object' ? payload.serverInfo : {}
    ) as Record<string, unknown>;
    this.initialized = true;
    // The handshake is only complete once the server is told the client is ready. A server that
    // does not accept the notification is still usable, so a failure here is not fatal.
    try {
      await this.notify('notifications/initialized', signal);
    } catch {
      /* the connection is still valid without the acknowledgement */
    }
    return {
      protocolVersion:
        typeof payload.protocolVersion === 'string' ? payload.protocolVersion : mcpProtocolVersion,
      serverName:
        typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'MCP server',
      serverVersion: typeof info.version === 'string' ? info.version : 'unknown',
    };
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    return parseMcpTools(await this.call('tools/list', {}, signal));
  }

  async listPrompts(signal?: AbortSignal): Promise<McpPromptDescriptor[]> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    try {
      return parseMcpPrompts(await this.call('prompts/list', {}, signal));
    } catch (error) {
      // Prompts are an optional MCP capability. A server without the method remains a valid
      // connection; transport, auth and malformed-response failures must still be visible.
      if (
        error instanceof Error &&
        /no such method|method not found|unknown method|no prompt list/i.test(error.message)
      ) {
        return [];
      }
      throw error;
    }
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    try {
      return parseMcpResources(await this.call('resources/list', {}, signal));
    } catch (error) {
      if (
        error instanceof Error &&
        /no such method|method not found|unknown method|no resource list/i.test(error.message)
      ) {
        return [];
      }
      throw error;
    }
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateDescriptor[]> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    try {
      return parseMcpResourceTemplates(await this.call('resources/templates/list', {}, signal));
    } catch (error) {
      if (
        error instanceof Error &&
        /no such method|method not found|unknown method|no resource template list/i.test(
          error.message,
        )
      ) {
        return [];
      }
      throw error;
    }
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceReadResult> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    return parseMcpResourceReadResult(await this.call('resources/read', { uri }, signal));
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<McpPromptResult> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    return parseMcpPromptResult(await this.call('prompts/get', { name, arguments: args }, signal));
  }

  async complete(
    request: McpCompletionRequest,
    signal?: AbortSignal,
  ): Promise<McpCompletionResult> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    if (!request.argument.name.trim() || request.argument.value.length > mcpCompletionTextLimit) {
      throw new Error('MCP completion arguments must be named and bounded.');
    }
    return parseMcpCompletionResult(await this.call('completion/complete', request, signal));
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.initialized) await this.initialize('IRIS', signal);
    const result = await this.call(
      'tools/call',
      { name, arguments: args && typeof args === 'object' ? args : {} },
      signal,
    );
    if (!result || typeof result !== 'object') {
      throw new Error('The MCP server returned an unreadable tool result.');
    }
    const payload = result as Record<string, unknown>;
    const text = textFromContent(payload.content);
    return {
      text: text || JSON.stringify(payload),
      isError: payload.isError === true,
    };
  }

  async close(): Promise<void> {
    await this.transport.close?.(this.sessionId);
    this.sessionId = undefined;
    this.initialized = false;
  }
}

export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`;
}

export function parseMcpToolId(toolId: string): { serverId: string; toolName: string } | null {
  if (!toolId.startsWith('mcp.')) return null;
  const rest = toolId.slice(4);
  const separator = rest.indexOf('.');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { serverId: rest.slice(0, separator), toolName: rest.slice(separator + 1) };
}

/**
 * The official registry, unlike the browsable directory, publishes the real endpoint of every remote
 * server, so an entry from here can be connected without the user hunting for an address.
 */
export interface McpRegistryRemote {
  transport: string;
  url: string;
  /** Header names the registry says this endpoint expects, e.g. Authorization. */
  headerNames: string[];
}

export interface McpRegistryEntry {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl?: string;
  remotes: McpRegistryRemote[];
  /** Local package transports, listed so an entry with no remote can say why it is unreachable. */
  packageTransports: string[];
}

export interface McpRegistryPage {
  entries: McpRegistryEntry[];
  nextCursor?: string;
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseRegistryRemote(value: unknown): McpRegistryRemote | null {
  if (!value || typeof value !== 'object') return null;
  const remote = value as Record<string, unknown>;
  const url = textOrEmpty(remote.url);
  const transport = textOrEmpty(remote.type) || 'streamable-http';
  if (!url) return null;
  return {
    transport,
    url,
    headerNames: Array.isArray(remote.headers)
      ? remote.headers.flatMap((header) => {
          const name =
            header && typeof header === 'object'
              ? textOrEmpty((header as Record<string, unknown>).name)
              : '';
          return name ? [name] : [];
        })
      : [],
  };
}

export function parseMcpRegistryEntry(value: unknown): McpRegistryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const wrapper = value as Record<string, unknown>;
  const raw =
    wrapper.server && typeof wrapper.server === 'object'
      ? (wrapper.server as Record<string, unknown>)
      : wrapper;
  const name = textOrEmpty(raw.name);
  if (!name) return null;
  return {
    name,
    title: textOrEmpty(raw.title) || name,
    description: textOrEmpty(raw.description),
    version: textOrEmpty(raw.version) || 'unknown',
    ...(textOrEmpty(raw.websiteUrl) ? { websiteUrl: textOrEmpty(raw.websiteUrl) } : {}),
    remotes: Array.isArray(raw.remotes)
      ? raw.remotes.flatMap((remote) => {
          const parsed = parseRegistryRemote(remote);
          return parsed ? [parsed] : [];
        })
      : [],
    packageTransports: Array.isArray(raw.packages)
      ? raw.packages.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const transport = (item as Record<string, unknown>).transport;
          const type =
            transport && typeof transport === 'object'
              ? textOrEmpty((transport as Record<string, unknown>).type)
              : '';
          return type ? [type] : [];
        })
      : [],
  };
}

export function parseMcpRegistryPage(value: unknown): McpRegistryPage {
  if (!value || typeof value !== 'object') {
    throw new Error('The MCP registry returned an unreadable response.');
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.servers)) {
    throw new Error('The MCP registry returned no server list.');
  }
  const entries = payload.servers.flatMap((item) => {
    const entry = parseMcpRegistryEntry(item);
    return entry ? [entry] : [];
  });
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const cursor = textOrEmpty(metadata.nextCursor);
  return { entries, ...(cursor ? { nextCursor: cursor } : {}) };
}

/** The endpoint IRIS would actually connect to, or null when the entry offers none it can reach. */
export function connectableRemote(entry: McpRegistryEntry): McpRegistryRemote | null {
  const supported = ['streamable-http', 'http', 'sse'];
  return entry.remotes.find((remote) => supported.includes(remote.transport.toLowerCase())) ?? null;
}

export function describeRegistryEntry(entry: McpRegistryEntry): string {
  const remote = connectableRemote(entry);
  if (remote) {
    return remote.headerNames.length
      ? `Reachable at ${remote.url}. The registry says it expects ${remote.headerNames.join(', ')}.`
      : `Reachable at ${remote.url}.`;
  }
  if (entry.packageTransports.length) {
    return 'This server ships only as a local package. IRIS does not start local processes yet, so it cannot be connected.';
  }
  return 'The registry publishes no endpoint for this server, so it cannot be connected.';
}
