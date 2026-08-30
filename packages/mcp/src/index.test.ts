import { describe, expect, it } from 'vitest';
import {
  McpClient,
  McpAuthorizationError,
  McpOAuthTokenError,
  authorizationServerMetadataUrls,
  buildAuthorizationUrl,
  connectableRemote,
  describeRegistryEntry,
  mcpAuthKind,
  mcpProtocolVersion,
  mcpToolId,
  parseJsonRpcBody,
  parseAuthorizationServerMetadata,
  parseClientRegistration,
  parseMcpRegistryEntry,
  parseMcpRegistryPage,
  parseProtectedResourceMetadata,
  parseResourceMetadataUrl,
  parseChallengeScopes,
  protectedResourceMetadataUrls,
  parseTokenResponse,
  tokensAreFresh,
  parseMcpTools,
  parseMcpPrompts,
  parseMcpPromptResult,
  parseMcpResources,
  parseMcpResourceTemplates,
  parseMcpResourceReadResult,
  parseMcpCompletionResult,
  parseMcpToolId,
  requireMcpServerName,
  requireMcpServerUrl,
  validateMcpServer,
  validateMcpStdioConfiguration,
  cloneMcpStdioConfiguration,
  parseMcpElicitationRequest,
  parseMcpSamplingRequest,
  type McpTransport,
  type McpTransportRequest,
  type McpTransportResponse,
} from './index';

function jsonResponse(body: unknown, extra: Partial<McpTransportResponse> = {}) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
    ...extra,
  } satisfies McpTransportResponse;
}

/** Answers each JSON-RPC method in turn and records exactly what the client sent. */
function transport(handlers: Record<string, (id: number) => McpTransportResponse>) {
  const sent: Array<{ method: string; request: McpTransportRequest }> = [];
  const source: McpTransport = {
    async send(request) {
      const payload = JSON.parse(request.payload) as { id?: number; method: string };
      sent.push({ method: payload.method, request });
      const handler = handlers[payload.method];
      if (!handler) return jsonResponse({ jsonrpc: '2.0', id: payload.id ?? 0, result: {} });
      return handler(payload.id ?? 0);
    },
  };
  return { source, sent };
}

const initializeOk = (id: number) =>
  jsonResponse(
    {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: mcpProtocolVersion,
        serverInfo: { name: 'Gmail MCP', version: '1.4.0' },
      },
    },
    { sessionId: 'session-abc' },
  );

const toolsOk = (id: number) =>
  jsonResponse({
    jsonrpc: '2.0',
    id,
    result: {
      tools: [
        {
          name: 'send_email',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
        },
        { name: 'list_labels' },
        { nonsense: true },
      ],
    },
  });

describe('MCP server addresses', () => {
  it('accepts HTTPS anywhere and HTTP only on loopback', () => {
    expect(requireMcpServerUrl('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp');
    expect(requireMcpServerUrl(' http://localhost:3000/mcp ')).toBe('http://localhost:3000/mcp');
    expect(() => requireMcpServerUrl('http://mcp.example.com/mcp')).toThrow(/HTTPS/);
  });

  it('refuses credentials in the address and unusable input', () => {
    expect(() => requireMcpServerUrl('https://user:pass@mcp.example.com/mcp')).toThrow(
      /token field/,
    );
    expect(() => requireMcpServerUrl('nonsense')).toThrow(/not a valid URL/);
    expect(() => requireMcpServerUrl('')).toThrow(/needs an address/);
    expect(() => requireMcpServerName('   ')).toThrow(/needs a name/);
  });

  it('validates persisted connections and rejects malformed ones', () => {
    const server = {
      version: 1 as const,
      id: 'mcp-1',
      name: 'Gmail',
      url: 'https://mcp.example.com/mcp',
      hasToken: true,
      createdAt: '2026-08-28T09:00:00.000Z',
      verifiedAt: null,
    };
    expect(validateMcpServer(server)).toBe(true);
    expect(validateMcpServer({ ...server, version: 2 })).toBe(false);
    expect(validateMcpServer({ ...server, hasToken: 'yes' })).toBe(false);
    expect(validateMcpServer(null)).toBe(false);
  });
});

describe('local stdio configuration boundary', () => {
  it('accepts bounded command data and clones it without executable authority', () => {
    const config = { command: 'npx', args: ['-y', 'server'], env: { NODE_ENV: 'production' } };
    expect(validateMcpStdioConfiguration(config)).toBe(true);
    const clone = cloneMcpStdioConfiguration(config);
    clone.args.push('--changed');
    expect(config.args).toEqual(['-y', 'server']);
  });

  it('rejects control characters, invalid environment names and oversized input', () => {
    expect(validateMcpStdioConfiguration({ command: 'node\n', args: [] })).toBe(false);
    expect(validateMcpStdioConfiguration({ command: 'node', args: [''] })).toBe(false);
    expect(
      validateMcpStdioConfiguration({ command: 'node', args: [], env: { 'BAD-NAME': 'x' } }),
    ).toBe(false);
    expect(
      validateMcpStdioConfiguration({
        command: 'node',
        args: Array.from({ length: 101 }, () => 'x'),
      }),
    ).toBe(false);
  });
});

describe('JSON-RPC envelope', () => {
  it('reads a plain JSON result', () => {
    expect(
      parseJsonRpcBody(jsonResponse({ jsonrpc: '2.0', id: 7, result: { ok: true } }), 7),
    ).toEqual({ ok: true });
  });

  it('reads the matching message out of an SSE stream', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"first":true}}',
      '',
      'data: {"jsonrpc":"2.0","id":2,"result":{"second":true}}',
      '',
    ].join('\n');
    const response = { status: 200, contentType: 'text/event-stream', body };
    expect(parseJsonRpcBody(response, 2)).toEqual({ second: true });
  });

  it('turns a JSON-RPC error into a real failure instead of an empty result', () => {
    expect(() =>
      parseJsonRpcBody(
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'No such method' } }),
        1,
      ),
    ).toThrow(/No such method \(code -32601\)/);
  });

  it('refuses unreadable or empty bodies', () => {
    expect(() =>
      parseJsonRpcBody({ status: 200, contentType: 'application/json', body: '' }, 1),
    ).toThrow(/empty response/);
    expect(() =>
      parseJsonRpcBody({ status: 200, contentType: 'application/json', body: 'nope' }, 1),
    ).toThrow(/not JSON/);
    expect(() =>
      parseJsonRpcBody({ status: 200, contentType: 'text/event-stream', body: 'data: nope' }, 1),
    ).toThrow(/no readable message/);
    expect(() => parseJsonRpcBody(jsonResponse({ jsonrpc: '2.0', id: 1 }), 1)).toThrow(/no result/);
  });
});

describe('MCP transport lifecycle', () => {
  it('closes the transport session after a client is finished', async () => {
    const closed: Array<string | undefined> = [];
    const source: McpTransport = {
      async send() {
        return initializeOk(1);
      },
      async close(sessionId) {
        closed.push(sessionId);
      },
    };
    const client = new McpClient('stdio://local/test', source);
    await client.initialize();
    await client.close();
    expect(closed).toEqual(['session-abc']);
  });
});

describe('server-initiated requests', () => {
  function responseWithServerRequest(id: number) {
    const events = [
      {
        jsonrpc: '2.0',
        id: 'server-1',
        method: 'sampling/createMessage',
        params: { prompt: 'hi' },
      },
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: mcpProtocolVersion,
          serverInfo: { name: 'Requesting MCP', version: '1.0.0' },
        },
      },
    ];
    return {
      status: 200,
      contentType: 'text/event-stream',
      sessionId: 'server-session',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n'),
    } satisfies McpTransportResponse;
  }

  it('denies by default and replies on the same session', async () => {
    const sent: Array<{ method: string; request: McpTransportRequest }> = [];
    const source: McpTransport = {
      async send(request) {
        const payload = JSON.parse(request.payload) as { id?: number | string; method: string };
        sent.push({ method: payload.method ?? `response:${payload.id}`, request });
        return payload.method === 'initialize'
          ? responseWithServerRequest(payload.id as number)
          : jsonResponse({ jsonrpc: '2.0', id: payload.id ?? 0, result: {} });
      },
    };
    const client = new McpClient('https://mcp.example.com/mcp', source);

    await client.initialize();

    const reply = JSON.parse(sent[1]!.request.payload) as { id: string; error: { code: number } };
    expect(sent.map((entry) => entry.method)).toEqual([
      'initialize',
      'response:server-1',
      'notifications/initialized',
    ]);
    expect(reply).toMatchObject({ id: 'server-1', error: { code: -32601 } });
    expect(sent[1]!.request.sessionId).toBe('server-session');
  });

  it('passes immutable provenance to an explicitly installed handler', async () => {
    let received: import('./index').McpServerRequest | undefined;
    const source: McpTransport = {
      async send(request) {
        const payload = JSON.parse(request.payload) as { id?: number | string; method: string };
        return payload.method === 'initialize'
          ? responseWithServerRequest(payload.id as number)
          : jsonResponse({ jsonrpc: '2.0', id: payload.id ?? 0, result: {} });
      },
    };
    const client = new McpClient('https://mcp.example.com/mcp', source);
    client.setServerRequestHandler(async (request) => {
      received = request;
      return { status: 'allow', result: { accepted: true } };
    });

    await client.initialize();

    expect(received).toMatchObject({
      method: 'sampling/createMessage',
      id: 'server-1',
      provenance: {
        serverUrl: 'https://mcp.example.com/mcp',
        sessionId: 'server-session',
        method: 'sampling/createMessage',
        requestId: 'server-1',
      },
    });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.provenance)).toBe(true);
  });

  it('honours cancellation before replying to a server request', async () => {
    const source: McpTransport = {
      async send(request) {
        const payload = JSON.parse(request.payload) as { id?: number | string; method: string };
        return payload.method === 'initialize'
          ? responseWithServerRequest(payload.id as number)
          : jsonResponse({ jsonrpc: '2.0', id: payload.id ?? 0, result: {} });
      },
    };
    const client = new McpClient('https://mcp.example.com/mcp', source);
    const controller = new AbortController();
    client.setServerRequestHandler(async (_request, signal) => {
      controller.abort();
      signal.throwIfAborted();
      return { status: 'allow', result: null };
    });

    await expect(client.initialize('IRIS', controller.signal)).rejects.toThrow();
  });
});

describe('MCP elicitation forms', () => {
  it('accepts a bounded primitive form and preserves required fields', () => {
    expect(
      parseMcpElicitationRequest({
        mode: 'form',
        message: 'Choose a release channel.',
        requestedSchema: {
          type: 'object',
          required: ['channel'],
          properties: {
            channel: { type: 'string', title: 'Channel', enum: ['stable', 'beta'] },
            notify: { type: 'boolean' },
          },
        },
      }),
    ).toEqual({
      mode: 'form',
      message: 'Choose a release channel.',
      fields: [
        {
          name: 'channel',
          title: 'Channel',
          type: 'string',
          required: true,
          enum: ['stable', 'beta'],
        },
        { name: 'notify', title: 'notify', type: 'boolean', required: false },
      ],
    });
  });

  it('refuses URL mode, unsupported field types and oversized forms', () => {
    expect(
      parseMcpElicitationRequest({ mode: 'url', message: 'Sign in', requestedSchema: {} }),
    ).toBeNull();
    expect(
      parseMcpElicitationRequest({
        mode: 'form',
        message: 'Pick',
        requestedSchema: { type: 'object', properties: { data: { type: 'array' } } },
      }),
    ).toBeNull();
    expect(
      parseMcpElicitationRequest({
        mode: 'form',
        message: 'Pick',
        requestedSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 21 }, (_, index) => [`field${index}`, { type: 'string' }]),
          ),
        },
      }),
    ).toBeNull();
  });
});

describe('MCP sampling requests', () => {
  it('normalizes bounded text messages and generation options', () => {
    expect(
      parseMcpSamplingRequest({
        systemPrompt: 'Be concise.',
        messages: [{ role: 'user', content: 'Summarize this.' }],
        modelPreferences: { hints: ['local-fast'] },
        temperature: 0.2,
        maxTokens: 120,
        stopSequences: ['END'],
      }),
    ).toEqual({
      systemPrompt: 'Be concise.',
      messages: [{ role: 'user', content: 'Summarize this.' }],
      modelPreferences: { hints: ['local-fast'] },
      temperature: 0.2,
      maxTokens: 120,
      stopSequences: ['END'],
    });
  });

  it('rejects non-text content and unsafe generation limits', () => {
    expect(
      parseMcpSamplingRequest({
        messages: [{ role: 'user', content: [{ type: 'image' }] }],
        maxTokens: 20,
      }),
    ).toBeNull();
    expect(
      parseMcpSamplingRequest({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 99999,
      }),
    ).toBeNull();
    expect(
      parseMcpSamplingRequest({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 20,
        temperature: 3,
      }),
    ).toBeNull();
  });
});

describe('tool discovery', () => {
  it('keeps usable tools and drops entries with no name', () => {
    const tools = parseMcpTools({
      tools: [
        { name: 'send_email', description: 'Send a message', inputSchema: { type: 'object' } },
        { name: 'list_labels' },
        { description: 'no name' },
      ],
    });
    expect(tools.map((tool) => tool.name)).toEqual(['send_email', 'list_labels']);
    expect(tools[1]?.description).toBe('The list_labels tool exposed by this MCP server.');
    expect(tools[1]?.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('refuses a response that carries no tool list', () => {
    expect(() => parseMcpTools({})).toThrow(/no tool list/);
    expect(() => parseMcpTools('nope')).toThrow(/unreadable tool list/);
  });

  it('round-trips namespaced tool ids', () => {
    expect(mcpToolId('mcp-1', 'send_email')).toBe('mcp.mcp-1.send_email');
    expect(parseMcpToolId('mcp.mcp-1.send_email')).toEqual({
      serverId: 'mcp-1',
      toolName: 'send_email',
    });
    expect(parseMcpToolId('workspace.read')).toBeNull();
    expect(parseMcpToolId('mcp.only')).toBeNull();
  });
});

describe('prompt discovery', () => {
  it('parses bounded prompt descriptors and arguments', () => {
    expect(
      parseMcpPrompts({
        prompts: [
          {
            name: 'review',
            description: 'Review text',
            arguments: [{ name: 'text', required: true }],
          },
          { name: 'empty' },
          { description: 'ignored' },
        ],
      }),
    ).toEqual([
      {
        name: 'review',
        description: 'Review text',
        arguments: [{ name: 'text', description: '', required: true }],
      },
      { name: 'empty', description: 'The empty prompt exposed by this MCP server.', arguments: [] },
    ]);
    expect(() => parseMcpPrompts({})).toThrow(/no prompt list/);
  });

  it('normalizes prompt messages without granting tool authority', () => {
    expect(
      parseMcpPromptResult({
        description: 'A review',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Review this.' } },
          { role: 'assistant', content: { type: 'text', text: 'I will review it.' } },
          { role: 'system', content: { type: 'text', text: 'ignored' } },
        ],
      }),
    ).toEqual({
      description: 'A review',
      messages: [
        { role: 'user', text: 'Review this.' },
        { role: 'assistant', text: 'I will review it.' },
      ],
    });
  });
});

describe('resource discovery', () => {
  it('parses bounded resource descriptors and drops malformed entries', () => {
    expect(
      parseMcpResources({
        resources: [
          {
            uri: 'file:///readme.md',
            name: 'readme',
            description: 'A README',
            mimeType: 'text/markdown',
            size: 42,
          },
          { uri: 'urn:empty', name: 'empty' },
          { uri: 'missing-name' },
        ],
      }),
    ).toEqual([
      {
        uri: 'file:///readme.md',
        name: 'readme',
        description: 'A README',
        mimeType: 'text/markdown',
        size: 42,
      },
      {
        uri: 'urn:empty',
        name: 'empty',
        description: 'The empty resource exposed by this MCP server.',
      },
    ]);
    expect(() => parseMcpResources({})).toThrow(/no resource list/);
  });

  it('reads only bounded text or explicitly identified binary content', () => {
    expect(
      parseMcpResourceReadResult({
        contents: [
          { uri: 'file:///readme.md', mimeType: 'text/markdown', text: 'Hello' },
          { uri: 'file:///image.png', mimeType: 'image/png', blob: 'base64' },
          { uri: 'ignored' },
        ],
      }),
    ).toEqual({
      contents: [
        { uri: 'file:///readme.md', mimeType: 'text/markdown', text: 'Hello' },
        { uri: 'file:///image.png', mimeType: 'image/png', blob: 'base64' },
      ],
    });
    expect(() => parseMcpResourceReadResult({})).toThrow(/no resource contents/);
  });

  it('parses resource templates as metadata without turning URI patterns into tools', () => {
    expect(
      parseMcpResourceTemplates({
        resourceTemplates: [
          {
            uriTemplate: 'git://repo/{path}',
            name: 'repository files',
            title: 'Repository files',
            description: 'Browse a repository path.',
            mimeType: 'text/plain',
          },
          { uriTemplate: 'urn:default/{id}', name: 'default' },
          { uriTemplate: 'missing-name' },
        ],
      }),
    ).toEqual([
      {
        uriTemplate: 'git://repo/{path}',
        name: 'repository files',
        title: 'Repository files',
        description: 'Browse a repository path.',
        mimeType: 'text/plain',
      },
      {
        uriTemplate: 'urn:default/{id}',
        name: 'default',
        description: 'The default resource template exposed by this MCP server.',
      },
    ]);
    expect(() => parseMcpResourceTemplates({})).toThrow(/no resource template list/);
  });

  it('parses bounded completion values and rejects malformed server data', () => {
    expect(
      parseMcpCompletionResult({
        completion: { values: ['alpha', 'beta'], total: 4, hasMore: true },
      }),
    ).toEqual({ values: ['alpha', 'beta'], total: 4, hasMore: true });
    expect(() => parseMcpCompletionResult({ completion: { values: ['x'.repeat(2_001)] } })).toThrow(
      /invalid or oversized/,
    );
    expect(() => parseMcpCompletionResult({ completion: { values: 'alpha' } })).toThrow(
      /invalid or oversized completion values/,
    );
  });
});

describe('MCP client', () => {
  it('performs the handshake, acknowledges it and reuses the session id', async () => {
    const { source, sent } = transport({
      initialize: initializeOk,
      'tools/list': toolsOk,
      'prompts/list': (id) =>
        jsonResponse({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'review' }] } }),
      'resources/list': (id) =>
        jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { resources: [{ uri: 'urn:readme', name: 'readme' }] },
        }),
      'resources/templates/list': (id) =>
        jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { resourceTemplates: [{ uriTemplate: 'urn:file/{name}', name: 'file' }] },
        }),
    });
    const client = new McpClient('https://mcp.example.com/mcp', source, 'secret-token');

    const info = await client.initialize();
    expect(info).toEqual({
      protocolVersion: mcpProtocolVersion,
      serverName: 'Gmail MCP',
      serverVersion: '1.4.0',
    });

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['send_email', 'list_labels']);
    expect((await client.listPrompts())[0]?.name).toBe('review');
    expect((await client.listResources())[0]?.uri).toBe('urn:readme');
    expect((await client.listResourceTemplates())[0]?.uriTemplate).toBe('urn:file/{name}');

    expect(sent.map((entry) => entry.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'prompts/list',
      'resources/list',
      'resources/templates/list',
    ]);
    expect(sent[0]?.request.token).toBe('secret-token');
    expect(sent[0]?.request.sessionId).toBeUndefined();
    expect(sent[2]?.request.sessionId).toBe('session-abc');
  });

  it('initializes automatically before the first call', async () => {
    const { source, sent } = transport({ initialize: initializeOk, 'tools/list': toolsOk });
    await new McpClient('https://mcp.example.com/mcp', source).listTools();
    expect(sent[0]?.method).toBe('initialize');
  });

  it('keeps servers without the optional prompts capability usable', async () => {
    const { source } = transport({
      initialize: initializeOk,
      'prompts/list': (id) =>
        jsonResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }),
    });
    await expect(
      new McpClient('https://mcp.example.com/mcp', source).listPrompts(),
    ).resolves.toEqual([]);
  });

  it('keeps servers without the optional resources capability usable', async () => {
    const { source } = transport({
      initialize: initializeOk,
      'resources/list': (id) =>
        jsonResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }),
    });
    await expect(
      new McpClient('https://mcp.example.com/mcp', source).listResources(),
    ).resolves.toEqual([]);
  });

  it('keeps servers without the optional resource templates capability usable', async () => {
    const { source } = transport({
      initialize: initializeOk,
      'resources/templates/list': (id) =>
        jsonResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not found' },
        }),
    });
    await expect(
      new McpClient('https://mcp.example.com/mcp', source).listResourceTemplates(),
    ).resolves.toEqual([]);
  });

  it('stays usable when the server rejects the initialized notification', async () => {
    const { source } = transport({
      initialize: initializeOk,
      'notifications/initialized': () => {
        throw new Error('not supported');
      },
      'tools/list': toolsOk,
      'prompts/list': (id) => jsonResponse({ jsonrpc: '2.0', id, result: { prompts: [] } }),
    });
    const client = new McpClient('https://mcp.example.com/mcp', source);
    await expect(client.initialize()).resolves.toMatchObject({ serverName: 'Gmail MCP' });
    await expect(client.listTools()).resolves.toHaveLength(2);
  });

  it('reads text content out of a tool result', async () => {
    const { source } = transport({
      initialize: initializeOk,
      'tools/call': (id) =>
        jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Sent.' }, { type: 'image' }] },
        }),
    });
    const client = new McpClient('https://mcp.example.com/mcp', source);
    await expect(client.callTool('send_email', { to: 'a@b.c' })).resolves.toEqual({
      text: 'Sent.\n[image content]',
      isError: false,
    });
  });

  it('requests prompt argument completions through the active MCP session', async () => {
    const { source, sent } = transport({
      initialize: initializeOk,
      'completion/complete': (id) =>
        jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { completion: { values: ['inbox', 'important'], hasMore: false } },
        }),
    });
    const client = new McpClient('https://mcp.example.com/mcp', source);
    await expect(
      client.complete({
        ref: { type: 'ref/prompt', name: 'mailbox' },
        argument: { name: 'label', value: 'in' },
      }),
    ).resolves.toEqual({ values: ['inbox', 'important'], hasMore: false });
    expect(sent.at(-1)?.method).toBe('completion/complete');
    expect(sent.at(-1)?.request.sessionId).toBe('session-abc');
  });

  it('surfaces a tool error flag instead of pretending the call worked', async () => {
    const { source } = transport({
      initialize: initializeOk,
      'tools/call': (id) =>
        jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Quota exceeded' }], isError: true },
        }),
    });
    const client = new McpClient('https://mcp.example.com/mcp', source);
    await expect(client.callTool('send_email', {})).resolves.toEqual({
      text: 'Quota exceeded',
      isError: true,
    });
  });

  it('names a credential failure rather than reporting a generic error', async () => {
    const { source } = transport({
      initialize: () => ({ status: 401, contentType: 'application/json', body: '{}' }),
    });
    await expect(new McpClient('https://mcp.example.com/mcp', source).initialize()).rejects.toThrow(
      /rejected the credentials/,
    );
  });

  it('reports a failing HTTP status', async () => {
    const { source } = transport({
      initialize: () => ({ status: 502, contentType: 'text/html', body: 'bad gateway' }),
    });
    await expect(new McpClient('https://mcp.example.com/mcp', source).initialize()).rejects.toThrow(
      /HTTP 502/,
    );
  });
});

describe('official MCP registry', () => {
  const remoteEntry = {
    server: {
      name: 'com.mintmcp/gmail',
      title: 'Gmail',
      description: 'Read and send mail',
      version: '1.2.0',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://gmail.mintmcp.com/mcp',
          headers: [{ name: 'Authorization' }],
        },
      ],
    },
  };

  const localEntry = {
    server: {
      name: 'io.github.example/gmail',
      title: 'Local Gmail',
      description: 'Runs locally',
      version: '0.3.0',
      packages: [{ registryType: 'npm', identifier: 'gmail-mcp', transport: { type: 'stdio' } }],
    },
  };

  it('reads the published endpoint and the headers it expects', () => {
    const entry = parseMcpRegistryEntry(remoteEntry);
    expect(entry).toMatchObject({ name: 'com.mintmcp/gmail', title: 'Gmail', version: '1.2.0' });
    expect(entry?.remotes).toEqual([
      {
        transport: 'streamable-http',
        url: 'https://gmail.mintmcp.com/mcp',
        headerNames: ['Authorization'],
      },
    ]);
    expect(connectableRemote(entry!)?.url).toBe('https://gmail.mintmcp.com/mcp');
    expect(describeRegistryEntry(entry!)).toContain('expects Authorization');
  });

  it('says why a local-only server cannot be connected', () => {
    const entry = parseMcpRegistryEntry(localEntry)!;
    expect(entry.remotes).toEqual([]);
    expect(entry.packageTransports).toEqual(['stdio']);
    expect(connectableRemote(entry)).toBeNull();
    expect(describeRegistryEntry(entry)).toMatch(/does not start local processes/);
  });

  it('reports an entry with neither remote nor package honestly', () => {
    const entry = parseMcpRegistryEntry({ server: { name: 'io.github.example/empty' } })!;
    expect(describeRegistryEntry(entry)).toMatch(/publishes no endpoint/);
  });

  it('ignores remote transports IRIS cannot speak', () => {
    const entry = parseMcpRegistryEntry({
      server: { name: 'x/y', remotes: [{ type: 'carrier-pigeon', url: 'https://example.com' }] },
    })!;
    expect(connectableRemote(entry)).toBeNull();
  });

  it('drops entries with no name and carries the pagination cursor', () => {
    const page = parseMcpRegistryPage({
      servers: [remoteEntry, { server: { description: 'no name' } }],
      metadata: { nextCursor: 'ai.next/server:1.0.0', count: 2 },
    });
    expect(page.entries.map((item) => item.name)).toEqual(['com.mintmcp/gmail']);
    expect(page.nextCursor).toBe('ai.next/server:1.0.0');
  });

  it('omits the cursor on the last page and refuses an unreadable response', () => {
    expect(parseMcpRegistryPage({ servers: [], metadata: {} }).nextCursor).toBeUndefined();
    expect(() => parseMcpRegistryPage({ nope: true })).toThrow(/no server list/);
    expect(() => parseMcpRegistryPage('nope')).toThrow(/unreadable response/);
  });
});

describe('MCP authorization', () => {
  const realChallenge =
    'Bearer realm="OAuth", resource_metadata="https://gmail.mintmcp.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Missing or invalid access token"';

  it('reads the metadata document out of a real challenge header', () => {
    expect(parseResourceMetadataUrl(realChallenge)).toBe(
      'https://gmail.mintmcp.com/.well-known/oauth-protected-resource',
    );
  });

  it('uses challenged scopes exactly and removes duplicates', () => {
    expect(
      parseChallengeScopes(
        'Bearer error="insufficient_scope", scope="files:read files:write files:read"',
      ),
    ).toEqual(['files:read', 'files:write']);
    expect(parseChallengeScopes('Bearer realm="OAuth"')).toEqual([]);
  });

  it('constructs path-specific and origin protected-resource metadata fallbacks', () => {
    expect(
      protectedResourceMetadataUrls(
        'https://api.example.com/public/mcp/',
        'https://api.example.com/advertised-metadata',
      ),
    ).toEqual([
      'https://api.example.com/advertised-metadata',
      'https://api.example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://api.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('ignores a challenge that names nowhere safe to go', () => {
    expect(parseResourceMetadataUrl(undefined)).toBeNull();
    expect(parseResourceMetadataUrl('Bearer realm="OAuth"')).toBeNull();
    expect(parseResourceMetadataUrl('Bearer resource_metadata="http://insecure/x"')).toBeNull();
    expect(parseResourceMetadataUrl('Bearer resource_metadata="not a url"')).toBeNull();
  });

  it('separates an invitation to sign in from a plainly bad token', () => {
    const invited = new McpAuthorizationError(401, realChallenge);
    expect(invited.canAuthorize).toBe(true);
    expect(invited.message).toMatch(/requires you to sign in/);

    const rejected = new McpAuthorizationError(401, 'Bearer realm="OAuth"');
    expect(rejected.canAuthorize).toBe(false);
    expect(rejected.message).toMatch(/rejected the credentials/);
  });

  it('reads real protected resource metadata', () => {
    const metadata = parseProtectedResourceMetadata({
      resource: 'https://gmail.mintmcp.com',
      authorization_servers: ['https://gmail.mintmcp.com'],
      scopes_supported: ['openid', 'https://www.googleapis.com/auth/userinfo.email'],
    });
    expect(metadata.authorizationServers).toEqual(['https://gmail.mintmcp.com/']);
    expect(metadata.scopesSupported).toHaveLength(2);
  });

  it('refuses resource metadata that names no authorization server', () => {
    expect(() => parseProtectedResourceMetadata({ resource: 'x' })).toThrow(
      /names no authorization server/,
    );
    expect(() => parseProtectedResourceMetadata('nope')).toThrow(/unreadable/);
  });

  it('reads real authorization server metadata and requires HTTPS endpoints', () => {
    const metadata = parseAuthorizationServerMetadata({
      issuer: 'https://gmail.mintmcp.com',
      authorization_endpoint: 'https://gmail.mintmcp.com/authorize',
      token_endpoint: 'https://gmail.mintmcp.com/token',
      registration_endpoint: 'https://gmail.mintmcp.com/register',
      scopes_supported: ['openid'],
      code_challenge_methods_supported: ['S256'],
    });
    expect(metadata.tokenEndpoint).toBe('https://gmail.mintmcp.com/token');
    expect(metadata.registrationEndpoint).toBe('https://gmail.mintmcp.com/register');
    expect(metadata.supportsPkce).toBe(true);

    expect(() =>
      parseAuthorizationServerMetadata({
        issuer: 'https://x',
        authorization_endpoint: 'http://insecure/authorize',
        token_endpoint: 'https://x/token',
      }),
    ).toThrow(/over HTTPS/);
    expect(() =>
      parseAuthorizationServerMetadata({ issuer: 'https://x', token_endpoint: 'https://x/token' }),
    ).toThrow(/no authorization endpoint/);
  });

  it('does not assume PKCE when the server does not advertise S256', () => {
    const metadata = parseAuthorizationServerMetadata({
      issuer: 'https://x',
      authorization_endpoint: 'https://x/authorize',
      token_endpoint: 'https://x/token',
    });
    expect(metadata.supportsPkce).toBe(false);
  });

  it('places the well-known segment before the issuer path', () => {
    expect(authorizationServerMetadataUrls('https://example.com')).toContain(
      'https://example.com/.well-known/oauth-authorization-server',
    );
    const nested = authorizationServerMetadataUrls('https://example.com/tenant/a');
    expect(nested[0]).toBe('https://example.com/.well-known/oauth-authorization-server/tenant/a');
    expect(nested).toContain('https://example.com/tenant/a/.well-known/openid-configuration');
  });

  it('builds an authorization URL with PKCE and the resource binding', () => {
    const url = new URL(
      buildAuthorizationUrl({
        metadata: {
          issuer: 'https://x',
          authorizationEndpoint: 'https://x/authorize',
          tokenEndpoint: 'https://x/token',
          scopesSupported: [],
          supportsPkce: true,
        },
        client: { clientId: 'client-1' },
        redirectUri: 'http://127.0.0.1:5731/callback',
        state: 'state-1',
        codeChallenge: 'challenge-1',
        scopes: ['openid', 'email'],
        resource: 'https://gmail.mintmcp.com',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:5731/callback',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      scope: 'openid email',
      resource: 'https://gmail.mintmcp.com',
    });
  });

  it('omits the PKCE challenge when the server cannot verify it', () => {
    const url = new URL(
      buildAuthorizationUrl({
        metadata: {
          issuer: 'https://x',
          authorizationEndpoint: 'https://x/authorize',
          tokenEndpoint: 'https://x/token',
          scopesSupported: [],
          supportsPkce: false,
        },
        client: { clientId: 'c' },
        redirectUri: 'http://127.0.0.1:1/callback',
        state: 's',
        codeChallenge: 'ignored',
        scopes: [],
      }),
    );
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('reads a registered public client and refuses one without an id', () => {
    expect(parseClientRegistration({ client_id: 'abc' })).toEqual({ clientId: 'abc' });
    expect(parseClientRegistration({ client_id: 'abc', client_secret: 's' })).toEqual({
      clientId: 'abc',
      clientSecret: 's',
    });
    expect(() => parseClientRegistration({})).toThrow(/no client id/);
  });

  it('turns a token response into an absolute expiry and surfaces refusals', () => {
    const now = 1_800_000_000_000;
    expect(
      parseTokenResponse(
        { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid' },
        now,
      ),
    ).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: now + 3_600_000,
      scope: 'openid',
    });

    expect(parseTokenResponse({ access_token: 'at' }, now).expiresAt).toBeUndefined();
    expect(() =>
      parseTokenResponse({ error: 'invalid_grant', error_description: 'expired' }, now),
    ).toThrow(McpOAuthTokenError);
    try {
      parseTokenResponse({ error: 'invalid_grant', error_description: 'expired' }, now);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_grant', description: 'expired' });
    }
    expect(() => parseTokenResponse({}, now)).toThrow(/no access token/);
  });

  it('treats a token as stale a minute before it actually expires', () => {
    const now = 1_800_000_000_000;
    expect(tokensAreFresh({ accessToken: 'a' }, now)).toBe(true);
    expect(tokensAreFresh({ accessToken: 'a', expiresAt: now + 120_000 }, now)).toBe(true);
    expect(tokensAreFresh({ accessToken: 'a', expiresAt: now + 30_000 }, now)).toBe(false);
    expect(tokensAreFresh({ accessToken: 'a', expiresAt: now - 1 }, now)).toBe(false);
  });

  it('reports how a connection authenticates, including records written before sign-in existed', () => {
    const base = {
      version: 1 as const,
      id: 'mcp-1',
      name: 'Gmail',
      url: 'https://gmail.mintmcp.com/mcp',
      createdAt: '2026-08-28T09:00:00.000Z',
      verifiedAt: null,
    };
    expect(mcpAuthKind({ ...base, hasToken: false })).toBe('none');
    expect(mcpAuthKind({ ...base, hasToken: true })).toBe('token');
    expect(mcpAuthKind({ ...base, hasToken: true, auth: 'oauth' })).toBe('oauth');
  });
});
