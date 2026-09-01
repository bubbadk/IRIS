import { describe, expect, it } from 'vitest';
import type {
  ContextPack,
  ContextPackRepository,
  CortexTurnRecord,
  CortexTurnRepository,
  CortexTurnStep,
  CortexTurnStepRepository,
} from '@iris/cortex';
import type { ModelMessage, ModelProvider, ModelRequest } from '@iris/providers';
import {
  AgentRuntimeCoordinator,
  AgentSession,
  trimModelHistory,
  type AgentActivity,
  type AgentEvent,
  type AgentRepository,
  type AgentToolRuntime,
  type ConversationMessage,
  type ConversationRepository,
  type SuspendedAgentTurn,
  type SuspendedAgentTurnRepository,
} from './index';

describe('agent session', () => {
  it('completes visibly at the tool safety limit instead of throwing', async () => {
    let rounds = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'tools'],
      testConnection: async () => undefined,
      stream: async function* () {
        rounds += 1;
        if (rounds > 16) {
          yield { text: 'Summary of the real results.', done: true };
          return;
        }
        yield {
          text: rounds === 1 ? 'Checking. ' : '',
          toolCalls: [{ id: `call-${rounds}`, name: 'inspect', input: {} }],
          done: true,
        };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: 'inspect', description: 'Inspect', inputSchema: {} }],
      execute: async () => ({ status: 'completed', output: { status: 'ok' } }),
      resolve: async () => ({ status: 'completed', output: undefined }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'assist',
        skillIds: [],
        toolIds: ['inspect'],
      },
      provider,
      'test-model',
      [],
      tools,
    );

    const events = [];
    for await (const event of session.send('Check', undefined, [], 'turn-limit')) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: 'assistant-complete',
      message: { content: expect.stringContaining('Summary of the real results.') },
    });
    expect(rounds).toBe(17);
  });

  it('keeps injected context out of visible conversation history', async () => {
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat'],
        local: true,
      },
      capabilities: () => ['chat'],
      testConnection: async () => undefined,
      stream: async function* ({ messages }) {
        expect(messages).toEqual([
          { role: 'system', content: 'Saved workspace memory.' },
          { role: 'user', content: 'What do you remember?' },
        ]);
        yield { text: 'The saved context.', done: true };
      },
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'assist',
        memoryAccess: 'read',
        skillIds: [],
        toolIds: [],
      },
      provider,
      'test-model',
      [],
      undefined,
      undefined,
      [{ role: 'system', content: 'Saved workspace memory.' }],
    );

    const events = [];
    for await (const event of session.send('What do you remember?', undefined, [], 'turn-memory')) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe('assistant-complete');
    expect(session.messages()).toEqual([
      { role: 'user', content: 'What do you remember?', turnId: 'turn-memory' },
      { role: 'assistant', content: 'The saved context.', turnId: 'turn-memory' },
    ]);
  });

  it('uses fresh turn context without retaining stale context in later requests', async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat'],
        local: true,
      },
      capabilities: () => ['chat'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        yield { text: requests.length === 1 ? 'First answer.' : 'Second answer.', done: true };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Iris test', autonomy: 'assist', skillIds: [], toolIds: [] },
      provider,
      'test-model',
    );

    for await (const _event of session.send(
      'First question',
      undefined,
      [{ role: 'system', content: 'Relevant memory: alpha.' }],
      'turn-first',
    )) {
      void _event;
    }
    for await (const _event of session.send(
      'Second question',
      undefined,
      [{ role: 'system', content: 'Relevant memory: beta.' }],
      'turn-second',
    )) {
      void _event;
    }

    expect(requests[0]?.messages).toEqual([
      { role: 'system', content: 'Relevant memory: alpha.' },
      { role: 'user', content: 'First question' },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: 'system', content: 'Relevant memory: beta.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('keeps conversation history while yielding provider chunks', async () => {
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming'],
      testConnection: async () => undefined,
      stream: async function* ({ messages }) {
        expect(messages).toEqual([{ role: 'user', content: 'Hello' }]);
        yield { text: 'Hi', done: false };
        yield { text: ' there', done: true };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Iris test', autonomy: 'assist', skillIds: [], toolIds: [] },
      provider,
      'test-model',
    );

    const events = [];
    for await (const event of session.send('Hello', undefined, [], 'turn-hello')) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'user-message',
        message: { role: 'user', content: 'Hello', turnId: 'turn-hello' },
      },
      { type: 'assistant-chunk', text: 'Hi' },
      { type: 'assistant-chunk', text: ' there' },
      {
        type: 'assistant-complete',
        message: { role: 'assistant', content: 'Hi there', turnId: 'turn-hello' },
      },
    ]);
    expect(session.messages()).toEqual([
      { role: 'user', content: 'Hello', turnId: 'turn-hello' },
      { role: 'assistant', content: 'Hi there', turnId: 'turn-hello' },
    ]);
  });

  it('forwards the agent reasoning effort and streams reasoning as its own event, kept out of history', async () => {
    let requestedEffort: string | undefined;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming'],
      testConnection: async () => undefined,
      stream: async function* ({ reasoningEffort }) {
        requestedEffort = reasoningEffort;
        yield { text: '', done: false, reasoningText: 'Weighing the options.' };
        yield { text: 'Answer.', done: true };
      },
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'assist',
        skillIds: [],
        toolIds: [],
        reasoningEffort: 'high',
      },
      provider,
      'test-model',
    );

    const events = [];
    for await (const event of session.send('Hello', undefined, [], 'turn-reasoning')) {
      events.push(event);
    }

    expect(requestedEffort).toBe('high');
    expect(events).toEqual([
      {
        type: 'user-message',
        message: { role: 'user', content: 'Hello', turnId: 'turn-reasoning' },
      },
      { type: 'reasoning-chunk', text: 'Weighing the options.' },
      { type: 'assistant-chunk', text: 'Answer.' },
      {
        type: 'assistant-complete',
        message: { role: 'assistant', content: 'Answer.', turnId: 'turn-reasoning' },
      },
    ]);
    // The reasoning trace is scratch space shown live, not part of the durable conversation.
    expect(session.messages()).toEqual([
      { role: 'user', content: 'Hello', turnId: 'turn-reasoning' },
      { role: 'assistant', content: 'Answer.', turnId: 'turn-reasoning' },
    ]);
  });

  it('only spends the configured reasoning effort on the first round of a turn', async () => {
    const requestedEfforts: (string | undefined)[] = [];
    let round = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* ({ reasoningEffort }) {
        requestedEfforts.push(reasoningEffort);
        round += 1;
        if (round <= 2) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: `call-${round}`, name: 'step', input: {} }],
          };
          return;
        }
        yield { text: 'Done.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
      execute: async () => ({ status: 'completed', output: {} }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'act',
        skillIds: [],
        toolIds: ['step'],
        reasoningEffort: 'high',
      },
      provider,
      'test-model',
      [],
      tools,
    );

    for await (const _event of session.send('Build it', undefined, [], 'turn-multi-round')) {
      void _event;
    }

    // Round 0 (the initial plan) gets the configured effort in full; every round after a tool
    // call has already been made reacts to a known result instead, so it runs on a light "low"
    // budget rather than paying for "high" again each time.
    expect(requestedEfforts).toEqual(['high', 'low', 'low']);
  });

  it('leaves reasoning off on every round when the agent has it off entirely', async () => {
    const requestedEfforts: (string | undefined)[] = [];
    let round = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* ({ reasoningEffort }) {
        requestedEfforts.push(reasoningEffort);
        round += 1;
        if (round === 1) {
          yield { text: '', done: true, toolCalls: [{ id: 'call-1', name: 'step', input: {} }] };
          return;
        }
        yield { text: 'Done.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
      execute: async () => ({ status: 'completed', output: {} }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Iris test', autonomy: 'act', skillIds: [], toolIds: ['step'] },
      provider,
      'test-model',
      [],
      tools,
    );

    for await (const _event of session.send('Build it', undefined, [], 'turn-no-thinking')) {
      void _event;
    }

    expect(requestedEfforts).toEqual([undefined, undefined]);
  });

  it('keeps the full reasoning effort every round and carries thinking blocks forward for an interleaved-thinking provider', async () => {
    const requests: ModelRequest[] = [];
    let round = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'anthropic',
        name: 'Anthropic',
        kind: 'anthropic',
        capabilities: ['chat', 'streaming', 'tools'],
        local: false,
        reasoningContinuity: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        round += 1;
        if (round === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-1', name: 'step', input: {} }],
            thinkingBlocks: [{ type: 'thinking', thinking: 'Plan the step.', signature: 'sig-1' }],
          };
          return;
        }
        yield { text: 'Done.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
      execute: async () => ({ status: 'completed', output: {} }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'act',
        skillIds: [],
        toolIds: ['step'],
        reasoningEffort: 'high',
      },
      provider,
      'test-model',
      [],
      tools,
    );

    for await (const _event of session.send('Build it', undefined, [], 'turn-interleaved')) {
      void _event;
    }

    // Unlike a non-interleaving provider, every round keeps the full configured effort — the
    // provider carries the reasoning forward instead of losing it each round.
    expect(requests.map((sent) => sent.reasoningEffort)).toEqual(['high', 'high']);
    const carriedAssistant = requests[1]?.messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(carriedAssistant?.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'Plan the step.', signature: 'sig-1' },
    ]);
  });

  it('extends the same full-effort, carried-reasoning treatment to any provider that reports reasoningContinuity, not just kind === anthropic', async () => {
    // OpenRouter is `kind: 'openai-compatible'` — the same as any other custom endpoint — so this
    // has to be driven by the provider's own `reasoningContinuity` flag, not a hardcoded kind check.
    const requests: ModelRequest[] = [];
    let round = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openai-compatible',
        capabilities: ['chat', 'streaming', 'tools'],
        local: false,
        reasoningContinuity: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        round += 1;
        if (round === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-1', name: 'step', input: {} }],
            reasoningDetails: [{ index: 0, type: 'reasoning.text', text: 'Plan the step.' }],
          };
          return;
        }
        yield { text: 'Done.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
      execute: async () => ({ status: 'completed', output: {} }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'act',
        skillIds: [],
        toolIds: ['step'],
        reasoningEffort: 'high',
      },
      provider,
      'test-model',
      [],
      tools,
    );

    for await (const _event of session.send('Build it', undefined, [], 'turn-openrouter')) {
      void _event;
    }

    expect(requests.map((sent) => sent.reasoningEffort)).toEqual(['high', 'high']);
    const carriedAssistant = requests[1]?.messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(carriedAssistant?.reasoningDetails).toEqual([
      { index: 0, type: 'reasoning.text', text: 'Plan the step.' },
    ]);
  });

  it('drops carried thinking blocks once the turn that produced them concludes', async () => {
    const requests: ModelRequest[] = [];
    let round = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'anthropic',
        name: 'Anthropic',
        kind: 'anthropic',
        capabilities: ['chat', 'streaming', 'tools'],
        local: false,
        reasoningContinuity: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        round += 1;
        if (round === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-1', name: 'step', input: {} }],
            thinkingBlocks: [{ type: 'thinking', thinking: 'Plan the step.', signature: 'sig-1' }],
          };
          return;
        }
        yield { text: `Reply ${round}.`, done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
      execute: async () => ({ status: 'completed', output: {} }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Iris test',
        autonomy: 'act',
        skillIds: [],
        toolIds: ['step'],
        reasoningEffort: 'high',
      },
      provider,
      'test-model',
      [],
      tools,
    );

    for await (const _event of session.send('Build it', undefined, [], 'turn-1')) void _event;
    for await (const _event of session.send('Now something else', undefined, [], 'turn-2')) {
      void _event;
    }

    // The second turn's first request still carries the earlier assistant/tool-call exchange for
    // context, but its thinking is gone — that reasoning belonged to a turn that already concluded.
    const carriedAssistant = requests[2]?.messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(carriedAssistant?.thinkingBlocks).toBeUndefined();
  });

  it('forwards attached images on the user turn and keeps them in saved history', async () => {
    let sentImages: unknown;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming'],
      testConnection: async () => undefined,
      stream: async function* ({ messages }) {
        sentImages = messages.at(-1)?.images;
        yield { text: 'A cat.', done: true };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Iris test', autonomy: 'assist', skillIds: [], toolIds: [] },
      provider,
      'test-model',
    );
    const image = { mimeType: 'image/png', data: 'AAAA' };

    const events = [];
    for await (const event of session.send(
      'What is this?',
      undefined,
      [],
      'turn-image',
      [image],
    )) {
      events.push(event);
    }

    expect(sentImages).toEqual([image]);
    expect(events[0]).toEqual({
      type: 'user-message',
      message: { role: 'user', content: 'What is this?', turnId: 'turn-image', images: [image] },
    });
    expect(session.messages()[0]).toEqual({
      role: 'user',
      content: 'What is this?',
      turnId: 'turn-image',
      images: [image],
    });
  });

  it('sends an image-only turn even with no caption text', async () => {
    const provider: ModelProvider = {
      definition: { id: 'provider', name: 'Test', kind: 'test', capabilities: [], local: true },
      capabilities: () => [],
      testConnection: async () => undefined,
      stream: async function* () {
        yield { text: 'A cat.', done: true };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Iris test', autonomy: 'assist', skillIds: [], toolIds: [] },
      provider,
      'test-model',
    );

    const events = [];
    for await (const event of session.send('', undefined, [], 'turn-image-only', [
      { mimeType: 'image/png', data: 'AAAA' },
    ])) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(session.messages()[0]).toMatchObject({ content: '' });
  });

  it('does not create a message for blank input', async () => {
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat'],
        local: true,
      },
      capabilities: () => ['chat'],
      testConnection: async () => undefined,
      stream: async function* () {
        yield { text: 'unused', done: true };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Iris test', autonomy: 'assist', skillIds: [], toolIds: [] },
      provider,
      'test-model',
    );
    const events = [];
    for await (const event of session.send('   ')) events.push(event);
    expect(events).toEqual([]);
    expect(session.messages()).toEqual([]);
  });

  it('executes an allowed structured tool call and returns its output to the provider', async () => {
    const requests: ModelRequest[] = [];
    let invocation: { turnId: string; toolCallId: string } | undefined;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-1', name: 'system_inspect_host', input: {} }],
          };
          return;
        }
        yield { text: 'IRIS runs locally.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [
        {
          name: 'system_inspect_host',
          description: 'Reads host information.',
          inputSchema: { type: 'object' },
        },
      ],
      execute: async (_agent, _toolName, _input, context) => {
        invocation = context;
        return {
          status: 'completed',
          output: { operatingSystem: 'Linux' },
        };
      },
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Operator',
        autonomy: 'assist',
        skillIds: [],
        toolIds: ['system.inspect-host'],
      },
      provider,
      'test-model',
      [],
      tools,
    );

    const events = [];
    for await (const event of session.send('Where are you running?', undefined, [], 'turn-host')) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'user-message',
        message: { role: 'user', content: 'Where are you running?', turnId: 'turn-host' },
      },
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'system_inspect_host', input: {} },
      },
      {
        type: 'tool-complete',
        call: { id: 'call-1', name: 'system_inspect_host', input: {} },
        output: { operatingSystem: 'Linux' },
      },
      { type: 'assistant-chunk', text: 'IRIS runs locally.' },
      {
        type: 'assistant-complete',
        message: { role: 'assistant', content: 'IRIS runs locally.', turnId: 'turn-host' },
      },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'Where are you running?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'system_inspect_host', input: {} }],
      },
      {
        role: 'tool',
        content: '{"operatingSystem":"Linux"}',
        toolCallId: 'call-1',
        toolName: 'system_inspect_host',
      },
    ]);
    expect(session.messages()).toEqual([
      { role: 'user', content: 'Where are you running?', turnId: 'turn-host' },
      { role: 'assistant', content: 'IRIS runs locally.', turnId: 'turn-host' },
    ]);
    expect(invocation).toEqual({
      turnId: 'turn-host',
      toolCallId: 'call-1',
    });
  });

  it('runs every tool call from one round concurrently instead of one at a time', async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [
              { id: 'call-a', name: 'tool_a', input: {} },
              { id: 'call-b', name: 'tool_b', input: {} },
              { id: 'call-c', name: 'tool_c', input: {} },
            ],
          };
          return;
        }
        yield { text: 'All done.', done: true };
      },
    };

    // Every execute() blocks on the same gate, which only opens once all three calls have
    // started. If the runtime still ran calls one at a time, the first call would be stuck
    // awaiting the gate before a second call could ever start, and this test would time out.
    let started = 0;
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const tools: AgentToolRuntime = {
      definitions: () => [
        { name: 'tool_a', description: 'a', inputSchema: { type: 'object' } },
        { name: 'tool_b', description: 'b', inputSchema: { type: 'object' } },
        { name: 'tool_c', description: 'c', inputSchema: { type: 'object' } },
      ],
      execute: async (_agent, toolName) => {
        started += 1;
        if (started === 3) openGate?.();
        await gate;
        return { status: 'completed', output: { ran: toolName } };
      },
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Operator',
        autonomy: 'assist',
        skillIds: [],
        toolIds: ['a', 'b', 'c'],
      },
      provider,
      'test-model',
      [],
      tools,
    );

    const events = [];
    for await (const event of session.send('go', undefined, [], 'turn-parallel')) {
      events.push(event);
    }

    expect(started).toBe(3);
    expect(events.filter((event) => event.type === 'tool-call').map((event) => event.call.id)).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);
    expect(events.filter((event) => event.type === 'tool-complete')).toHaveLength(3);
    const toolResults = requests[1]?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(toolResults.map((message) => message.toolCallId).sort()).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);
  });

  it('surfaces multiple approval-required calls from one round one at a time', async () => {
    let providerRound = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [
              { id: 'call-ask-1', name: 'risky_a', input: {} },
              { id: 'call-ask-2', name: 'risky_b', input: {} },
            ],
          };
          return;
        }
        yield { text: 'Both handled.', done: true };
      },
    };
    const resolved: string[] = [];
    const tools: AgentToolRuntime = {
      definitions: () => [],
      execute: async (_agent, toolName) => ({
        status: 'approval-required',
        approval: {
          id: toolName === 'risky_a' ? 'approval-a' : 'approval-b',
          toolId: toolName,
          toolName,
          reason: 'Ask every time.',
        },
      }),
      resolve: async (approvalId, decision) => {
        resolved.push(approvalId);
        expect(decision).toBe('approve');
        return { status: 'completed', output: { approvalId } };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Operator', autonomy: 'act', skillIds: [], toolIds: [] },
      provider,
      'test-model',
      [],
      tools,
    );

    const initialEvents = [];
    for await (const event of session.send('Do both', undefined, [], 'turn-multi-approval')) {
      initialEvents.push(event);
    }
    // Both calls executed (each got a real approval id), but only the first is surfaced.
    expect(initialEvents.at(-1)).toEqual({
      type: 'tool-approval-required',
      call: { id: 'call-ask-1', name: 'risky_a', input: {} },
      approval: { id: 'approval-a', toolId: 'risky_a', toolName: 'risky_a', reason: 'Ask every time.' },
    });

    const afterFirst = [];
    for await (const event of session.resolveApproval('approval-a', 'approve')) {
      afterFirst.push(event);
    }
    // Resolving the first promotes the second instead of re-running it (only one `resolve` call
    // per approval id) or resuming the model early.
    expect(afterFirst).toEqual([
      { type: 'tool-complete', call: { id: 'call-ask-1', name: 'risky_a', input: {} }, output: { approvalId: 'approval-a' } },
      {
        type: 'tool-approval-required',
        call: { id: 'call-ask-2', name: 'risky_b', input: {} },
        approval: { id: 'approval-b', toolId: 'risky_b', toolName: 'risky_b', reason: 'Ask every time.' },
      },
    ]);

    const afterSecond = [];
    for await (const event of session.resolveApproval('approval-b', 'approve')) {
      afterSecond.push(event);
    }
    expect(afterSecond).toEqual([
      { type: 'tool-complete', call: { id: 'call-ask-2', name: 'risky_b', input: {} }, output: { approvalId: 'approval-b' } },
      { type: 'assistant-chunk', text: 'Both handled.' },
      {
        type: 'assistant-complete',
        message: { role: 'assistant', content: 'Both handled.', turnId: 'turn-multi-approval' },
      },
    ]);
    expect(resolved).toEqual(['approval-a', 'approval-b']);
  });

  it('returns a denied tool call to the provider and completes the agent turn', async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-denied', name: 'workspace_read', input: { path: 'notes.md' } }],
          };
          return;
        }
        yield { text: 'I cannot read that file without permission.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [
        {
          name: 'workspace_read',
          description: 'Reads one workspace file.',
          inputSchema: { type: 'object' },
        },
      ],
      execute: async () => ({
        status: 'denied',
        reason: 'No permission rule allows this tool.',
      }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Operator',
        autonomy: 'assist',
        skillIds: [],
        toolIds: ['workspace.read'],
      },
      provider,
      'test-model',
      [],
      tools,
    );

    const events = [];
    for await (const event of session.send('Read notes.md', undefined, [], 'turn-denied')) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'user-message',
        message: { role: 'user', content: 'Read notes.md', turnId: 'turn-denied' },
      },
      {
        type: 'tool-call',
        call: { id: 'call-denied', name: 'workspace_read', input: { path: 'notes.md' } },
      },
      {
        type: 'tool-denied',
        call: { id: 'call-denied', name: 'workspace_read', input: { path: 'notes.md' } },
        reason: 'No permission rule allows this tool.',
      },
      { type: 'assistant-chunk', text: 'I cannot read that file without permission.' },
      {
        type: 'assistant-complete',
        message: {
          role: 'assistant',
          content: 'I cannot read that file without permission.',
          turnId: 'turn-denied',
        },
      },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'Read notes.md' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-denied', name: 'workspace_read', input: { path: 'notes.md' } }],
      },
      {
        role: 'tool',
        content: 'Tool access was denied: No permission rule allows this tool.',
        toolCallId: 'call-denied',
        toolName: 'workspace_read',
      },
    ]);
    expect(session.messages()).toEqual([
      { role: 'user', content: 'Read notes.md', turnId: 'turn-denied' },
      {
        role: 'assistant',
        content: 'I cannot read that file without permission.',
        turnId: 'turn-denied',
      },
    ]);
  });

  it('returns a failed tool call to the provider so the turn can explain the real outcome', async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-mail', name: 'mcp_gmail_send', input: { subject: 'Hej' } }],
          };
          return;
        }
        yield { text: 'Gmail needs you to sign in again from Connections.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({
        status: 'failed',
        reason: 'Gmail needs you to sign in again from Connections.',
      }),
      resolve: async () => ({ status: 'approval-denied' }),
    };
    const session = new AgentSession(
      {
        id: 'agent',
        name: 'Operator',
        autonomy: 'assist',
        skillIds: [],
        toolIds: ['mcp.gmail.send'],
      },
      provider,
      'test-model',
      [],
      tools,
    );

    const events = [];
    for await (const event of session.send('Send mail', undefined, [], 'turn-mail')) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: 'tool-failed',
      call: { id: 'call-mail', name: 'mcp_gmail_send', input: { subject: 'Hej' } },
      reason: 'Gmail needs you to sign in again from Connections.',
    });
    expect(requests[1]?.messages).toContainEqual({
      role: 'tool',
      content: 'Tool execution failed: Gmail needs you to sign in again from Connections.',
      toolCallId: 'call-mail',
      toolName: 'mcp_gmail_send',
    });
    expect(session.messages().at(-1)).toEqual({
      role: 'assistant',
      content: 'Gmail needs you to sign in again from Connections.',
      turnId: 'turn-mail',
    });
  });

  it('pauses for a persisted approval and resumes after an explicit decision', async () => {
    let providerRound = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-ask', name: 'system_inspect_host', input: {} }],
          };
          return;
        }
        yield { text: 'Approved and inspected.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({
        status: 'approval-required',
        approval: {
          id: 'approval-1',
          toolId: 'system.inspect-host',
          toolName: 'Inspect IRIS host',
          reason: 'Ask every time.',
        },
      }),
      resolve: async (approvalId, decision) => {
        expect({ approvalId, decision }).toEqual({
          approvalId: 'approval-1',
          decision: 'approve',
        });
        return { status: 'completed', output: { architecture: 'x86_64' } };
      },
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Operator', autonomy: 'act', skillIds: [], toolIds: [] },
      provider,
      'test-model',
      [],
      tools,
    );

    const initialEvents = [];
    for await (const event of session.send('Inspect', undefined, [], 'turn-approval')) {
      initialEvents.push(event);
    }
    expect(initialEvents.at(-1)).toEqual({
      type: 'tool-approval-required',
      call: { id: 'call-ask', name: 'system_inspect_host', input: {} },
      approval: {
        id: 'approval-1',
        toolId: 'system.inspect-host',
        toolName: 'Inspect IRIS host',
        reason: 'Ask every time.',
      },
    });
    expect(session.messages()).toEqual([
      { role: 'user', content: 'Inspect', turnId: 'turn-approval' },
    ]);

    const resumedEvents = [];
    for await (const event of session.resolveApproval('approval-1', 'approve')) {
      resumedEvents.push(event);
    }
    expect(resumedEvents).toEqual([
      {
        type: 'tool-complete',
        call: { id: 'call-ask', name: 'system_inspect_host', input: {} },
        output: { architecture: 'x86_64' },
      },
      { type: 'assistant-chunk', text: 'Approved and inspected.' },
      {
        type: 'assistant-complete',
        message: {
          role: 'assistant',
          content: 'Approved and inspected.',
          turnId: 'turn-approval',
        },
      },
    ]);
  });

  it('continues a suspended turn when the approved tool itself fails', async () => {
    let providerRound = 0;
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'tools'],
      testConnection: async () => undefined,
      stream: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            text: '',
            done: true,
            toolCalls: [{ id: 'call-mail', name: 'mcp_gmail_send', input: {} }],
          };
          return;
        }
        yield { text: 'The approved Gmail call failed because its scope was revoked.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({
        status: 'approval-required',
        approval: {
          id: 'approval-mail',
          toolId: 'mcp.gmail.send',
          toolName: 'Gmail: send',
          reason: 'Ask before external calls.',
        },
      }),
      resolve: async () => ({
        status: 'failed',
        reason: 'Gmail reported that the granted scope was revoked.',
      }),
    };
    const session = new AgentSession(
      { id: 'agent', name: 'Operator', autonomy: 'act', skillIds: [], toolIds: [] },
      provider,
      'test-model',
      [],
      tools,
    );

    for await (const _event of session.send('Send it', undefined, [], 'turn-approved-failure')) {
      void _event;
    }
    const resumed = [];
    for await (const event of session.resolveApproval('approval-mail', 'approve')) {
      resumed.push(event);
    }

    expect(resumed[0]).toEqual({
      type: 'tool-failed',
      call: { id: 'call-mail', name: 'mcp_gmail_send', input: {} },
      reason: 'Gmail reported that the granted scope was revoked.',
    });
    expect(resumed.at(-1)).toMatchObject({ type: 'assistant-complete' });
  });

  it('persists a suspended turn and resumes it through a fresh runtime instance', async () => {
    const agent = {
      id: 'agent',
      name: 'Operator',
      autonomy: 'act' as const,
      providerPolicyId: 'provider',
      skillIds: [],
      toolIds: ['system.inspect-host'],
    };
    const agents: AgentRepository = {
      list: async () => [agent],
      get: async (id) => (id === agent.id ? agent : null),
      save: async () => undefined,
      remove: async () => undefined,
    };
    let savedConversation: ConversationMessage[] = [];
    const conversations: ConversationRepository = {
      list: async () => savedConversation.map((message) => ({ ...message })),
      save: async (_agentId, messages) => {
        savedConversation = messages.map((message) => ({ ...message }));
      },
      clear: async () => {
        savedConversation = [];
      },
    };
    let savedTurn: SuspendedAgentTurn | null = null;
    const suspendedTurns: SuspendedAgentTurnRepository = {
      getByAgentId: async (agentId) => (savedTurn?.agentId === agentId ? savedTurn : null),
      getByApprovalId: async (approvalId) =>
        savedTurn?.pending.approval.id === approvalId ? savedTurn : null,
      save: async (turn) => {
        savedTurn = turn;
      },
      remove: async (approvalId) => {
        if (savedTurn?.pending.approval.id === approvalId) savedTurn = null;
      },
    };
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming', 'tools'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming', 'tools'],
      testConnection: async () => undefined,
      stream: async function* (request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            text: 'Checking ',
            done: true,
            toolCalls: [{ id: 'call-1', name: 'system_inspect_host', input: {} }],
          };
          return;
        }
        yield { text: 'done.', done: true };
      },
    };
    const tools: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({
        status: 'approval-required',
        approval: {
          id: 'approval-1',
          toolId: 'system.inspect-host',
          toolName: 'Inspect IRIS host',
          reason: 'Ask every time.',
        },
      }),
      resolve: async () => ({ status: 'completed', output: { operatingSystem: 'Linux' } }),
    };
    const providers = {
      resolve: async () => ({ provider, model: 'test-model' }),
    };
    let savedContextPack: ContextPack | null = null;
    const contextPacks: ContextPackRepository = {
      list: async () => (savedContextPack ? [savedContextPack] : []),
      listAll: async () => (savedContextPack ? [savedContextPack] : []),
      latest: async () => savedContextPack,
      save: async (pack) => {
        savedContextPack = pack;
      },
      clear: async () => {
        savedContextPack = null;
      },
    };
    let savedCortexTurn: CortexTurnRecord | null = null;
    const cortexTurns: CortexTurnRepository = {
      list: async (agentId) =>
        savedCortexTurn?.agentId === agentId ? [{ ...savedCortexTurn }] : [],
      get: async (turnId) => (savedCortexTurn?.turnId === turnId ? { ...savedCortexTurn } : null),
      save: async (record) => {
        savedCortexTurn = record;
      },
      clear: async () => {
        savedCortexTurn = null;
      },
    };
    let savedTurnSteps: CortexTurnStep[] = [];
    const turnSteps: CortexTurnStepRepository = {
      list: async (turnId) =>
        savedTurnSteps.filter((step) => step.turnId === turnId).map((step) => ({ ...step })),
      listForAgent: async (agentId) =>
        savedTurnSteps.filter((step) => step.agentId === agentId).map((step) => ({ ...step })),
      save: async (step) => {
        savedTurnSteps = [
          ...savedTurnSteps.filter(
            (candidate) => candidate.turnId !== step.turnId || candidate.toolCallId !== step.toolCallId,
          ),
          { ...step },
        ];
      },
      clear: async (agentId) => {
        savedTurnSteps = savedTurnSteps.filter((step) => step.agentId !== agentId);
      },
    };

    const firstRuntime = new AgentRuntimeCoordinator(
      agents,
      conversations,
      suspendedTurns,
      providers,
      tools,
      undefined,
      {
        build: async (_agent, request) => ({
          version: 2,
          id: 'context-1',
          agentId: agent.id,
          turnId: request.turnId,
          prompt: request.prompt,
          createdAt: '2026-08-27T12:00:00.000Z',
          sources: [
            {
              source: 'memory',
              state: 'selected',
              detail: '1 saved record was selected for this prompt.',
            },
          ],
          selections: [
            {
              source: 'memory',
              sourceId: 'memory-1',
              content: `Turn memory for: ${request.prompt}`,
              reason: 'Selected by the configured memory retriever for this prompt at rank 1.',
              provenance: {
                source: 'user',
                actorId: 'workspace-user',
                actorName: 'Workspace user',
                capturedAt: '2026-08-27T11:00:00.000Z',
              },
            },
          ],
        }),
      },
      contextPacks,
      cortexTurns,
      undefined,
      undefined,
      undefined,
      turnSteps,
    );
    const pausedEvents: AgentEvent[] = [];
    for await (const event of firstRuntime.send(agent.id, 'Inspect the host')) {
      pausedEvents.push(event);
    }

    expect(pausedEvents.at(-1)?.type).toBe('tool-approval-required');
    expect(pausedEvents[0]).toMatchObject({
      type: 'context-pack-ready',
      pack: {
        id: 'context-1',
        turnId: expect.stringMatching(/^turn-/),
        selections: [{ sourceId: 'memory-1' }],
      },
    });
    const contextEvent = pausedEvents.find((event) => event.type === 'context-pack-ready');
    if (!contextEvent || contextEvent.type !== 'context-pack-ready') {
      throw new Error('Expected the runtime to yield a context pack.');
    }
    const runtimeTurnId = contextEvent.pack.turnId;
    expect(savedContextPack).toMatchObject({
      id: 'context-1',
      agentId: agent.id,
      turnId: runtimeTurnId,
    });
    expect(savedTurn).toMatchObject({
      version: 2,
      agentId: agent.id,
      providerId: 'provider',
      model: 'test-model',
      pending: {
        turnId: runtimeTurnId,
        approval: { id: 'approval-1' },
        assistantText: 'Checking ',
        context: [
          {
            role: 'system',
            content: expect.stringContaining('Turn memory for: Inspect the host'),
          },
        ],
      },
    });
    expect(savedConversation).toEqual([
      { role: 'user', content: 'Inspect the host', turnId: runtimeTurnId },
    ]);
    expect(savedCortexTurn).toMatchObject({
      turnId: runtimeTurnId,
      agentId: agent.id,
      contextPackId: 'context-1',
      providerId: 'provider',
      model: 'test-model',
      status: 'suspended',
      suspension: {
        approvalId: 'approval-1',
        toolId: 'system.inspect-host',
      },
    });
    expect(savedTurnSteps).toEqual([
      {
        version: 1,
        turnId: runtimeTurnId,
        agentId: agent.id,
        toolCallId: 'call-1',
        toolName: 'system_inspect_host',
        input: {},
        status: 'awaiting-approval',
        approvalId: 'approval-1',
        startedAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const restartedRuntime = new AgentRuntimeCoordinator(
      agents,
      conversations,
      suspendedTurns,
      providers,
      tools,
      undefined,
      undefined,
      contextPacks,
      cortexTurns,
      undefined,
      undefined,
      undefined,
      turnSteps,
    );
    const resumedEvents = [];
    for await (const event of restartedRuntime.resolveApproval('approval-1', 'approve')) {
      resumedEvents.push(event);
    }

    expect(savedTurn).toBeNull();
    expect(savedCortexTurn).toMatchObject({
      turnId: runtimeTurnId,
      status: 'completed',
    });
    expect(savedConversation).toEqual([
      { role: 'user', content: 'Inspect the host', turnId: runtimeTurnId },
      { role: 'assistant', content: 'Checking done.', turnId: runtimeTurnId },
    ]);
    expect(requests[1]?.messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('Turn memory for: Inspect the host'),
      },
      { role: 'user', content: 'Inspect the host' },
      {
        role: 'assistant',
        content: 'Checking ',
        toolCalls: [{ id: 'call-1', name: 'system_inspect_host', input: {} }],
      },
      {
        role: 'tool',
        content: '{"operatingSystem":"Linux"}',
        toolCallId: 'call-1',
        toolName: 'system_inspect_host',
      },
    ]);
    expect(resumedEvents.at(-1)).toEqual({
      type: 'assistant-complete',
      message: { role: 'assistant', content: 'Checking done.', turnId: runtimeTurnId },
    });
    expect(savedTurnSteps).toEqual([
      expect.objectContaining({
        turnId: runtimeTurnId,
        toolCallId: 'call-1',
        status: 'completed',
        output: { operatingSystem: 'Linux' },
      }),
    ]);

    savedCortexTurn = {
      version: 1,
      turnId: 'turn-interrupted',
      agentId: agent.id,
      contextPackId: 'context-interrupted',
      providerId: 'provider',
      model: 'test-model',
      status: 'running',
      startedAt: '2026-08-27T13:00:00.000Z',
      updatedAt: '2026-08-27T13:00:00.000Z',
    };
    const recoveryRuntime = new AgentRuntimeCoordinator(
      agents,
      conversations,
      suspendedTurns,
      providers,
      tools,
      undefined,
      undefined,
      contextPacks,
      cortexTurns,
      () => new Date('2026-08-27T13:05:00.000Z'),
    );
    await expect(recoveryRuntime.cortexTurnsForAgent(agent.id)).resolves.toEqual([
      expect.objectContaining({
        turnId: 'turn-interrupted',
        status: 'failed',
        failedAt: '2026-08-27T13:05:00.000Z',
        failure: { message: 'IRIS stopped before this turn reached a final state.' },
      }),
    ]);
  });

  it('broadcasts a live activity event for every agent event, tagged with the agent name', async () => {
    const agent = { id: 'agent', name: 'IRIS', autonomy: 'assist' as const, skillIds: [], toolIds: [] };
    const agents: AgentRepository = {
      list: async () => [agent],
      get: async (id) => (id === agent.id ? agent : null),
      save: async () => undefined,
      remove: async () => undefined,
    };
    let savedConversation: ConversationMessage[] = [];
    const conversations: ConversationRepository = {
      list: async () => savedConversation,
      save: async (_agentId, messages) => {
        savedConversation = messages;
      },
      clear: async () => {
        savedConversation = [];
      },
    };
    const suspendedTurns: SuspendedAgentTurnRepository = {
      getByAgentId: async () => null,
      getByApprovalId: async () => null,
      save: async () => undefined,
      remove: async () => undefined,
    };
    const provider: ModelProvider = {
      definition: {
        id: 'provider',
        name: 'Test',
        kind: 'test',
        capabilities: ['chat', 'streaming'],
        local: true,
      },
      capabilities: () => ['chat', 'streaming'],
      testConnection: async () => undefined,
      stream: async function* () {
        yield { text: 'Hi.', done: true };
      },
    };
    const providers = { resolve: async () => ({ provider, model: 'test-model' }) };
    const tools: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({ status: 'completed', output: null }),
      resolve: async () => ({ status: 'approval-denied' }),
    };

    const activity: AgentActivity[] = [];
    const runtime = new AgentRuntimeCoordinator(
      agents,
      conversations,
      suspendedTurns,
      providers,
      tools,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (entry) => activity.push(entry),
    );

    for await (const _event of runtime.send('agent', 'hello')) void _event;

    expect(activity.length).toBeGreaterThan(0);
    expect(activity.every((entry) => entry.agentId === 'agent' && entry.agentName === 'IRIS')).toBe(
      true,
    );
    expect(activity.map((entry) => entry.event.type)).toEqual([
      'user-message',
      'assistant-chunk',
      'assistant-complete',
    ]);
  });
});

describe('trimModelHistory', () => {
  const user = (content: string): ModelMessage => ({ role: 'user', content });
  const assistant = (content: string): ModelMessage => ({ role: 'assistant', content });
  const toolCall = (): ModelMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'run', input: { q: 'x' } }],
  });
  const toolResult = (content: string): ModelMessage => ({
    role: 'tool',
    content,
    toolCallId: 'c1',
    toolName: 'run',
  });

  it('leaves history untouched when it fits the budget', () => {
    const history = [user('hi'), assistant('hello')];
    expect(trimModelHistory(history, 1000)).toEqual({ history, dropped: 0 });
  });

  it('drops whole oldest exchanges and keeps tool pairs intact', () => {
    const history = [
      user('one'.repeat(20)),
      toolCall(),
      toolResult('r'.repeat(20)),
      assistant('done one'),
      user('two'),
      assistant('done two'),
      user('three'),
      assistant('done three'),
    ];
    const result = trimModelHistory(history, 40);
    // The first exchange (user..assistant, 4 messages incl. the tool pair) is dropped as a unit.
    expect(result.dropped).toBe(4);
    expect(result.history[0].role).toBe('assistant');
    expect(result.history[0].content).toContain('trimmed 4 earlier messages');
    expect(result.history.slice(1)).toEqual([
      user('two'),
      assistant('done two'),
      user('three'),
      assistant('done three'),
    ]);
    // No orphaned tool result is ever left at the front.
    expect(result.history.some((message, index) => index > 0 && message.role === 'tool')).toBe(
      false,
    );
  });

  it('never drops the only remaining exchange even when it exceeds the budget', () => {
    const history = [user('x'.repeat(500)), assistant('y'.repeat(500))];
    expect(trimModelHistory(history, 10)).toEqual({ history, dropped: 0 });
  });

  it('never drops the exchange immediately before the newest one, even a huge tool-heavy turn', () => {
    // Simulates the exact "type continue after a long build turn" scenario: one giant exchange
    // (many tool rounds, no user message in between) followed by a short new user message. Even
    // wildly over budget, the giant exchange must survive so the model still remembers its work.
    const bigTurn = [
      user('build the project'),
      ...Array.from({ length: 16 }, () => [toolCall(), toolResult('x'.repeat(200))]).flat(),
      assistant('done building'),
    ];
    const history = [...bigTurn, user('continue')];
    expect(trimModelHistory(history, 40)).toEqual({ history, dropped: 0 });
  });
});
