/**
 * IRIS Phase 2I.3 — channel failure & crash recovery.
 *
 * These are the permanent product regressions for finding H2: a single failed, crashed or poison
 * inbound update must never latch the durable channel runtime and wedge every later update across a
 * restart, and it must never be resolved by fabricating a success or by blindly replaying an effect
 * whose outcome is unknown.
 *
 * Every scenario drives the real `pollChannelOnce` over the real `RepositoryTransactions` CAS
 * (revision-checked commit), so failure-state persistence goes through the same atomic path as
 * production. No product file is bypassed and no test-only helper is substituted for the runner.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SnapshotStorage } from './repositoryStorage';
import type { IncomingChannelMessage } from './bridgeGateway';
import { ToolApprovalStateError, type ToolApprovalRequest } from '@iris/tools';

const native = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), load: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock('./credentials', () => ({
  loadProviderSecrets: native.load,
  saveProviderSecrets: native.save,
}));

/**
 * The authoritative approval lifecycle is only instrumented, never replaced: the durable
 * compare-and-set settlement is the real one and still runs against the same repository backend.
 */
const settlement = vi.hoisted(() => ({ count: 0, agentResumes: 0, projectResolutions: 0 }));
vi.mock('./agentRuntime', () => ({
  agentRuntime: {
    suspendedForApproval: vi.fn(async () => null),
    resolveApproval: vi.fn(async () => {
      settlement.agentResumes += 1;
      throw new Error('An agent resume must not happen in this scenario.');
    }),
  },
  providerResolver: { resolve: vi.fn() },
}));
vi.mock('./projectRuntime', () => ({
  projectWorkflowRuntime: {
    suspendedForApproval: vi.fn(async () => null),
    resolveApproval: vi.fn(async () => {
      settlement.projectResolutions += 1;
    }),
  },
}));
vi.mock('./tooling', () => ({
  createToolExecutor: () => ({
    resolve: async (approvalId: string, decision: 'approve' | 'deny') => {
      const settled = await toolApprovalRepository.compareAndSet(approvalId, 'pending', {
        ...approvalRecord(approvalId),
        status: decision === 'approve' ? 'approved' : 'denied',
      } as ToolApprovalRequest);
      if (!settled) throw new ToolApprovalStateError('Approval was already resolved.');
      settlement.count += 1;
      return { status: 'completed', output: null };
    },
  }),
}));

import { resolveRemoteApproval } from './channelApprovals';
import { toolApprovalRepository } from './persistence';

const inboxKey = 'iris.channels.inbox.v1';
const runtimeKey = 'iris.channels.runtime.v1';

/** The durable repository survives a simulated process restart; nothing else does. */
let values: Record<string, string>;
let revisions: Record<string, number>;
let storage: SnapshotStorage;
let now = 1_800_000_000_000;
/** What the host answers for a foreign claim's OS process. */
let processVerdict: 'alive' | 'dead' | 'unknown' = 'dead';
const ownPid = 4242;

const update = (id: number, chatId = 123) => ({
  update_id: id,
  message: { chat: { id: chatId }, text: `approve approval-${id}`, date: 1 },
});
const response = (result: unknown[]) =>
  ({ ok: true, json: async () => ({ ok: true, result }) }) as Response;

/** A pending approval record for the remote-approval regression below. */
function approvalRecord(id: string): ToolApprovalRequest {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    agentId: 'agent-1',
    agentName: 'IRIS',
    toolId: 'web.search',
    toolName: 'Web search',
    input: { query: 'fixture' },
    evaluation: { decision: 'ask', reason: 'Ask.' },
  };
}

async function gateway() {
  return import('./bridgeGateway');
}
type Gateway = Awaited<ReturnType<typeof gateway>>;

function installNativeBackend() {
  native.invoke.mockReset().mockImplementation(
    async (
      command: string,
      args: { expected?: Record<string, number>; changes?: Record<string, string | null> },
    ) => {
      if (command === 'repository_initialize') return;
      if (command === 'process_own_pid') return ownPid;
      if (command === 'process_is_alive') return { status: processVerdict };
      if (command === 'repository_snapshot')
        return { values: { ...values }, revisions: { ...revisions } };
      if (command === 'repository_commit') {
        if (
          Object.entries(args.expected!).some(([key, revision]) => (revisions[key] ?? 0) !== revision)
        )
          return false;
        for (const [key, value] of Object.entries(args.changes!)) {
          if (value === null) delete values[key];
          else values[key] = value;
          revisions[key] = (revisions[key] ?? 0) + 1;
        }
        return true;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  );
}

async function setup() {
  const g = await gateway();
  await g.migrateChannels();
  const config = structuredClone(g.defaultChannelsConfig);
  config.telegram = {
    ...config.telegram,
    enabled: true,
    botToken: 'fixture-token',
    allowedChatIds: ['123'],
  };
  return { g, config };
}

/**
 * A full process teardown and recreation: the module graph (and every process-local flag in it) is
 * discarded, the web-storage stub is replaced, and only the durable repository document remains.
 */
async function restart(): Promise<Gateway> {
  vi.resetModules();
  storage = new SnapshotStorage();
  vi.stubGlobal('localStorage', storage);
  return gateway();
}

const runtime = () => JSON.parse(values[runtimeKey]) as Record<string, unknown>;
const callsFor = (handle: { mock: { calls: unknown[][] } }, id: string) =>
  handle.mock.calls.filter((call) => (call[0] as IncomingChannelMessage).id === id).length;

beforeEach(() => {
  vi.resetModules();
  values = {};
  revisions = {};
  now = 1_800_000_000_000;
  processVerdict = 'dead';
  settlement.count = 0;
  settlement.agentResumes = 0;
  settlement.projectResolutions = 0;
  storage = new SnapshotStorage();
  vi.stubGlobal('localStorage', storage);
  native.save.mockReset().mockResolvedValue(true);
  native.load.mockReset().mockResolvedValue(null);
  installNativeBackend();
  // Only Date.now() is controlled, so the durable backoff gates are deterministic without
  // faking the timer queue the async repository work depends on.
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    response([update(1), update(2), update(3)]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// §19 — ordinary effect failure
// ---------------------------------------------------------------------------------------------
it('§19 an effect that throws leaves no forever-pending state and the channel keeps progressing', async () => {
  const { g, config } = await setup();
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id === 'tg-2') throw new Error('semantic effect failed');
  });
  const first = await g.pollChannelOnce({ config, handle });
  expect(first.status).toBe('completed');
  expect(first.status === 'completed' ? first.error : undefined).toContain(
    'Channel update 2 needs attention',
  );
  // Truthful durable state: transport advanced, the failure is recorded, no pending latch remains.
  expect(runtime()).toEqual({
    version: 2,
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 2, outcome: 'unknown', attempts: 1 })],
  });
  // The failed effect is never reported as a success and never replayed.
  expect(callsFor(handle, 'tg-2')).toBe(1);
  expect(callsFor(handle, 'tg-3')).toBe(1);

  const restarted = await restart();
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(callsFor(handle, 'tg-2')).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// §20 — restart recovery against durable state only
// ---------------------------------------------------------------------------------------------
it('§20 process A fails an effect; process B recovers from the durable repository and makes progress', async () => {
  const { g, config } = await setup();
  const handleA = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id === 'tg-1') throw new Error('effect failed in process A');
  });
  const firstA = await g.pollChannelOnce({ config, handle: handleA });
  expect(firstA.status).toBe('completed');
  expect(runtime()).toMatchObject({
    version: 2,
    attention: [expect.objectContaining({ updateId: 1, outcome: 'unknown' })],
  });
  expect(callsFor(handleA, 'tg-1')).toBe(1);
  // Process A also processed 2 and 3 in the same poll before teardown.
  expect(callsFor(handleA, 'tg-3')).toBe(1);

  // Process B starts fresh from the same repository: update 1 is already classified, so a new
  // update 4 must still be able to progress.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    response([update(1), update(2), update(3), update(4)]),
  );
  const restarted = await restart();
  const handledByB: string[] = [];
  const handleB = vi.fn(async (message: IncomingChannelMessage) => {
    handledByB.push(message.id);
  });
  const firstB = await restarted.pollChannelOnce({ config, handle: handleB });
  expect(firstB.status).toBe('completed');
  expect(handledByB).toEqual(['tg-4']);
  expect(runtime()).toMatchObject({ lastUpdateId: 5 });
});

it('§20 a claim persisted by process A before its effect runs is replayed only once by process B', async () => {
  const { g, config } = await setup();
  // Simulate the exact crash window: A committed its write-ahead claim and died before the effect.
  values[runtimeKey] = JSON.stringify({
    version: 2,
    lastUpdateId: 1,
    pending: { updateId: 1, replay: 'safe', effect: true, attempts: 1, attemptedAt: now },
  });
  values[inboxKey] = JSON.stringify([
    {
      id: 'tg-1',
      platform: 'telegram',
      chatId: '123',
      senderName: 'Fixture',
      text: 'approve approval-1',
      timestamp: new Date(0).toISOString(),
    },
  ]);
  vi.resetModules();
  const restarted = await gateway();
  await restarted.migrateChannels();
  const handle = vi.fn(async () => {});
  now += 60_000; // the bounded replay window has elapsed
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(callsFor(handle, 'tg-1')).toBe(1);
  expect(runtime()).toMatchObject({ version: 2, lastUpdateId: 4 });
  expect(runtime().pending).toBeUndefined();
  expect(runtime().attention).toBeUndefined();
  void g;
});

// ---------------------------------------------------------------------------------------------
// §21 — poison update
// ---------------------------------------------------------------------------------------------
it('§21 a permanently failing effect is retried a bounded number of times, then classified as poison', async () => {
  const { g, config } = await setup();
  let attempts = 0;
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id === 'tg-1') {
      attempts += 1;
      throw new g.ChannelEffectRetryableError();
    }
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([update(1), update(2)]));

  // Attempt 1 (the claim's first attempt): the effect declares a safe replay.
  expect(await g.pollChannelOnce({ config, handle })).toMatchObject({
    status: 'uncertain',
    updateId: 1,
  });
  expect(attempts).toBe(1);
  expect(runtime()).toMatchObject({
    lastUpdateId: 0,
    pending: { updateId: 1, replay: 'safe', attempts: 2 },
  });

  // No aggressive spin: the backoff gate refuses an immediate second attempt.
  expect(await g.pollChannelOnce({ config, handle })).toMatchObject({ status: 'uncertain' });
  expect(attempts).toBe(1);

  // Attempt 2.
  now += g.CHANNEL_EFFECT_RETRY_BACKOFF_MS;
  expect(await g.pollChannelOnce({ config, handle })).toMatchObject({ status: 'uncertain' });
  expect(attempts).toBe(2);
  expect(runtime()).toMatchObject({ pending: { updateId: 1, attempts: 3 } });

  // Attempt 3 exhausts the budget: the update becomes durable poison, not an infinite retry.
  now += g.CHANNEL_EFFECT_RETRY_BACKOFF_MS;
  const third = await g.pollChannelOnce({ config, handle });
  expect(third.status).toBe('completed');
  expect(attempts).toBe(g.CHANNEL_EFFECT_MAX_ATTEMPTS);
  expect(runtime()).toMatchObject({
    version: 2,
    attention: [expect.objectContaining({ updateId: 1, outcome: 'poison', attempts: 3 })],
  });
  expect(runtime().pending).toBeUndefined();
  // N+1 is not silently lost: it progresses in the same poll that terminally classified N.
  expect(callsFor(handle, 'tg-2')).toBe(1);
  expect(runtime().lastUpdateId).toBe(3);

  // After a restart the poison update is never retried again.
  const restarted = await restart();
  const afterRestart = vi.fn(async () => {});
  await restarted.pollChannelOnce({ config, handle: afterRestart });
  expect(attempts).toBe(3);
  expect(runtime().attention).toHaveLength(1);
});

it('§17 a declared retryable failure that succeeds on replay executes exactly once overall', async () => {
  const { g, config } = await setup();
  let attempts = 0;
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id !== 'tg-1') return;
    attempts += 1;
    if (attempts === 1) throw new g.ChannelEffectRetryableError();
  });
  expect(await g.pollChannelOnce({ config, handle })).toMatchObject({ status: 'uncertain' });
  now += g.CHANNEL_EFFECT_RETRY_BACKOFF_MS;
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(attempts).toBe(2);
  expect(runtime()).toMatchObject({ version: 2, lastUpdateId: 4 });
  expect(runtime().attention).toBeUndefined();
  expect(runtime().pending).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------
// §22 — completed effect, later failure
// ---------------------------------------------------------------------------------------------
it('§22 an effect that completes and then fails a later step executes exactly once and is never replayed', async () => {
  const { g, config } = await setup();
  let executions = 0;
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id !== 'tg-1') return;
    executions += 1;
    throw new g.ChannelEffectCompletedError();
  });
  const first = await g.pollChannelOnce({ config, handle });
  expect(first.status).toBe('completed');
  expect(executions).toBe(1);
  expect(runtime()).toMatchObject({
    version: 2,
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 1, outcome: 'completed-with-warning' })],
  });
  // The durable completion is not a pending latch: later updates progress.
  expect(callsFor(handle, 'tg-2')).toBe(1);

  const restarted = await restart();
  await restarted.pollChannelOnce({ config, handle });
  expect(executions).toBe(1);
  expect(runtime().attention).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------
// §26 / §27 — duplicate identity and mixed prefixes
// ---------------------------------------------------------------------------------------------
it('§26 a replayed provider update identity never repeats the semantic effect', async () => {
  const { g, config } = await setup();
  const handle = vi.fn(async () => {});
  // Same identity twice inside one batch, then the whole batch replayed by transport.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([update(1), update(1), update(2)]));
  await g.pollChannelOnce({ config, handle });
  await g.pollChannelOnce({ config, handle });
  expect(callsFor(handle, 'tg-1')).toBe(1);
  expect(callsFor(handle, 'tg-2')).toBe(1);
  expect(runtime()).toMatchObject({ lastUpdateId: 3 });
});

it('§26 an update already classified as needs-attention is never re-executed by a transport replay', async () => {
  const { g, config } = await setup();
  values[runtimeKey] = JSON.stringify({
    version: 2,
    lastUpdateId: 0,
    attention: [
      {
        updateId: 1,
        outcome: 'unknown',
        attempts: 1,
        reason: 'The effect outcome could not be determined, so it was not replayed automatically.',
        at: now,
      },
    ],
  });
  const restarted = await restart();
  const handle = vi.fn(async () => {});
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
  // Update 1 is never re-executed; only the genuinely new updates 2 and 3 are handled.
  expect(callsFor(handle, 'tg-1')).toBe(0);
  expect(callsFor(handle, 'tg-2')).toBe(1);
  expect(runtime()).toMatchObject({ lastUpdateId: 4, attention: expect.any(Array) });
  void g;
});

it('§27 a batch N/N+1/N+2 with a poison middle update classifies each and replays none', async () => {
  const { g, config } = await setup();
  const executed: string[] = [];
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    executed.push(message.id);
    if (message.id === 'tg-2') throw new Error('poison');
  });
  const first = await g.pollChannelOnce({ config, handle });
  expect(first.status).toBe('completed');
  expect(executed).toEqual(['tg-1', 'tg-2', 'tg-3']);
  expect(runtime()).toEqual({
    version: 2,
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 2, outcome: 'unknown', attempts: 1 })],
  });

  // Restart and repeat the observation: no prefix update is replayed.
  const restarted = await restart();
  const replayed: string[] = [];
  const handleAfter = vi.fn(async (message: IncomingChannelMessage) => {
    replayed.push(message.id);
  });
  expect((await restarted.pollChannelOnce({ config, handle: handleAfter })).status).toBe('completed');
  expect(replayed).toEqual([]);
  expect(executed).toEqual(['tg-1', 'tg-2', 'tg-3']);
  expect(runtime()).toMatchObject({ lastUpdateId: 4 });
  expect(runtime().attention).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------
// §28 — poll guard
// ---------------------------------------------------------------------------------------------
it('§28 the poll guard releases after an effect exception and after a restart', async () => {
  const { g, config } = await setup();
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id === 'tg-1') throw new Error('effect failed');
  });
  await g.pollChannelOnce({ config, handle });
  // Not "skipped": the guard is gone, so a second poll after an effect exception still runs.
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(callsFor(handle, 'tg-1')).toBe(1);
  const restarted = await restart();
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
});

it('§28 the poll guard still excludes a concurrent poll while fetch is blocked', async () => {
  const { g, config } = await setup();
  let release!: (value: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const running = g.pollChannelOnce({ config, handle: vi.fn(async () => {}) });
  await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
  expect(await g.pollChannelOnce({ config, handle: vi.fn(async () => {}) })).toEqual({
    status: 'skipped',
  });
  release(response([update(1)]));
  await running;
});

// ---------------------------------------------------------------------------------------------
// Durable-model integrity
// ---------------------------------------------------------------------------------------------
it('adopts a legacy version 1 pending claim as unreplayable and recovers the wedged channel', async () => {
  const { g, config } = await setup();
  // The exact document a pre-2I.3 process left behind while latched.
  values[runtimeKey] = JSON.stringify({
    version: 1,
    lastUpdateId: 2,
    pending: { updateId: 2, outcome: 'uncertain' },
  });
  const restarted = await restart();
  const handle = vi.fn(async () => {});
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
  // The legacy effect is never replayed, and the truth is recorded instead of being silently lost.
  expect(callsFor(handle, 'tg-2')).toBe(0);
  expect(runtime()).toMatchObject({
    version: 2,
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 2, outcome: 'unknown' })],
  });
  expect(runtime().pending).toBeUndefined();
  void g;
});

it('recovers an unreplayable claim that crashed before its effect ran without inventing success', async () => {
  const { g, config } = await setup();
  values[runtimeKey] = JSON.stringify({
    version: 2,
    lastUpdateId: 1,
    pending: { updateId: 1, replay: 'unsafe', effect: true, attempts: 1, attemptedAt: now },
  });
  const restarted = await restart();
  const handle = vi.fn(async () => {});
  await restarted.pollChannelOnce({ config, handle });
  expect(callsFor(handle, 'tg-1')).toBe(0);
  expect(runtime()).toMatchObject({
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 1, outcome: 'unknown' })],
  });
  void g;
});

it('recovers a filtered update claim without recording a false failure', async () => {
  const { g, config } = await setup();
  values[runtimeKey] = JSON.stringify({
    version: 2,
    lastUpdateId: 1,
    pending: { updateId: 1, replay: 'safe', effect: false, attempts: 1, attemptedAt: now },
  });
  const restarted = await restart();
  const handle = vi.fn(async () => {});
  await restarted.pollChannelOnce({ config, handle });
  // The filtered update carries no effect, so it is neither replayed nor reported as a failure.
  expect(callsFor(handle, 'tg-1')).toBe(0);
  expect(runtime()).toMatchObject({ version: 2, lastUpdateId: 4 });
  expect(runtime().attention).toBeUndefined();
  void g;
});

it('bounds the durable attention evidence instead of growing the runtime document without limit', async () => {
  const { g, config } = await setup();
  const batch = Array.from({ length: 25 }, (_, index) => update(index + 1));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(batch));
  const handle = vi.fn(async () => {
    throw new Error('every effect fails');
  });
  await g.pollChannelOnce({ config, handle });
  const records = runtime().attention as { updateId: number }[];
  expect(records).toHaveLength(g.CHANNEL_ATTENTION_LIMIT);
  expect(records[0].updateId).toBe(25);
  expect(runtime().lastUpdateId).toBe(26);
});

it('exposes durable needs-attention truth without leaking message content', async () => {
  const { g, config } = await setup();
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id === 'tg-1') throw new Error('secret-token-should-not-persist');
  });
  await g.pollChannelOnce({ config, handle });
  const attention = await g.loadChannelAttention();
  expect(attention).toEqual([
    expect.objectContaining({ updateId: 1, outcome: 'unknown' }),
  ]);
  expect(JSON.stringify(attention)).not.toContain('secret-token-should-not-persist');
  expect(values[runtimeKey]).not.toContain('secret-token-should-not-persist');
});

// ---------------------------------------------------------------------------------------------
// §16 / §29 — cross-runtime claim ownership (two IRIS instances share one repository)
// ---------------------------------------------------------------------------------------------
/** A durable claim held by a different runtime, exactly as the other instance would have written it. */
async function foreignClaim(
  g: Gateway,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<{ owner: string; value: string }> {
  const identity = await g.channelClaimIdentity();
  return {
    owner: identity.token,
    value: JSON.stringify({
      version: 2,
      lastUpdateId: 1,
      pending: {
        updateId: 1,
        replay: 'safe',
        effect: true,
        attempts: 1,
        attemptedAt: now,
        owner: identity.token,
        ownerPid: ownPid,
        ownerAt: now,
        ...overrides,
      },
    }),
  };
}

it('§16 a live foreign owner with a fresh lease is never replayed and never stolen', async () => {
  const { g, config } = await setup();
  const foreign = await foreignClaim(g);
  values[runtimeKey] = foreign.value;
  // A second IRIS instance: new JS runtime (new ownership token), same durable repository.
  const other = await restart();
  await other.migrateChannels();
  processVerdict = 'alive';
  const handle = vi.fn(async () => {});
  expect(await other.pollChannelOnce({ config, handle })).toMatchObject({
    status: 'uncertain',
    updateId: 1,
  });
  expect(handle).not.toHaveBeenCalled();
  // The claim still belongs to its owner and its replay safety is untouched.
  expect(JSON.parse(values[runtimeKey]).pending).toMatchObject({
    updateId: 1,
    replay: 'safe',
    owner: foreign.owner,
  });
});

it('§16 a positive death verdict recovers a fresh foreign claim immediately', async () => {
  const { g, config } = await setup();
  values[runtimeKey] = (await foreignClaim(g, { replay: 'unsafe' })).value;
  const other = await restart();
  await other.migrateChannels();
  processVerdict = 'dead';
  const handle = vi.fn(async () => {});
  expect((await other.pollChannelOnce({ config, handle })).status).toBe('completed');
  // The other process died with a possibly-executed effect: recorded as unknown, never replayed.
  expect(callsFor(handle, 'tg-1')).toBe(0);
  expect(runtime()).toMatchObject({
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 1, outcome: 'unknown' })],
  });
  expect(runtime().pending).toBeUndefined();
});

it('§16 unknown liveness fails closed while fresh and recovers once the lease lapses', async () => {
  const { g, config } = await setup();
  values[runtimeKey] = (await foreignClaim(g, { replay: 'unsafe' })).value;
  const other = await restart();
  await other.migrateChannels();
  processVerdict = 'unknown';
  const handle = vi.fn(async () => {});
  // Unknown is never treated as dead: the claim stays with its owner while the lease is valid.
  expect(await other.pollChannelOnce({ config, handle })).toMatchObject({ status: 'uncertain' });
  expect(handle).not.toHaveBeenCalled();
  expect(runtime().pending).toMatchObject({ updateId: 1, replay: 'unsafe' });
  // Once no heartbeat has arrived for a full lease the claim is abandoned and truthfully reconciled.
  now += g.CHANNEL_CLAIM_LEASE_MS;
  expect((await other.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(callsFor(handle, 'tg-1')).toBe(0);
  expect(runtime().attention).toEqual([
    expect.objectContaining({ updateId: 1, outcome: 'unknown' }),
  ]);
});

it('§16 an alive process whose runtime stopped heartbeating is recovered after the lease', async () => {
  const { g, config } = await setup();
  values[runtimeKey] = (await foreignClaim(g, { replay: 'unsafe' })).value;
  const other = await restart();
  await other.migrateChannels();
  processVerdict = 'alive';
  const handle = vi.fn(async () => {});
  expect((await other.pollChannelOnce({ config, handle })).status).toBe('uncertain');
  now += g.CHANNEL_CLAIM_LEASE_MS;
  expect((await other.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(runtime()).toMatchObject({
    attention: [expect.objectContaining({ updateId: 1, outcome: 'unknown' })],
  });
});

it('§29 a claim taken over by another runtime fences the original owner out of the effect', async () => {
  const { g } = await setup();
  const identity = await g.channelClaimIdentity();
  const other = { token: 'other-runtime', pid: null };
  await g.channelRepository.claim(1, undefined, identity);
  expect(await g.channelRepository.markEffectStarted(1, identity.token)).not.toBeNull();
  const claimed = await g.channelRepository.pendingClaim();
  // The other runtime proves abandonment and takes the claim atomically.
  expect(
    await g.channelRepository.takeover(
      1,
      { owner: claimed!.owner, ownerAt: claimed!.ownerAt },
      other,
    ),
  ).toMatchObject({ owner: 'other-runtime' });
  // The original owner observes the fence and must not start the effect; it also cannot complete or
  // finalize the claim, so a takeover can never produce two semantic executions.
  expect(await g.channelRepository.markEffectStarted(1, identity.token)).toBeNull();
  await expect(g.channelRepository.complete(1, identity.token)).rejects.toThrow(
    'owned by another runtime',
  );
  expect(
    await g.channelRepository.finalize(1, identity.token, {
      updateId: 1,
      outcome: 'unknown',
      attempts: 1,
      reason: 'a losing owner must not record',
      at: now,
    }),
  ).toBe(false);
  // Only the new owner may advance it.
  await g.channelRepository.complete(1, other.token);
  expect(runtime()).toMatchObject({ lastUpdateId: 2 });
});

it('§29 a stale takeover attempt loses when the owner renewed the claim in between', async () => {
  const { g } = await setup();
  const identity = await g.channelClaimIdentity();
  await g.channelRepository.claim(1, undefined, identity);
  const seen = await g.channelRepository.pendingClaim();
  // The owner heartbeats (a new ownerAt) before the contender commits its takeover.
  now += 5_000;
  await g.channelRepository.renewClaim(1, identity.token);
  expect(
    await g.channelRepository.takeover(
      1,
      { owner: seen!.owner, ownerAt: seen!.ownerAt },
      { token: 'contender', pid: null },
    ),
  ).toBeNull();
  expect((await g.channelRepository.pendingClaim())!.owner).toBe(identity.token);
});

it('§29 a heartbeat keeps a long effect owned by its runtime', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { g, config } = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const handle = vi.fn(async (message: IncomingChannelMessage) => {
      if (message.id === 'tg-1') {
        entered();
        await blocked;
      }
    });
    const running = g.pollChannelOnce({ config, handle });
    await reached;
    const before = (await g.channelRepository.pendingClaim())!.ownerAt;
    now += g.CHANNEL_CLAIM_HEARTBEAT_MS;
    await vi.advanceTimersByTimeAsync(g.CHANNEL_CLAIM_HEARTBEAT_MS);
    const after = (await g.channelRepository.pendingClaim())!.ownerAt;
    expect(after).toBeGreaterThan(before);
    release();
    await running;
    // The heartbeat timer is a reversible side effect: nothing is left pending after the attempt.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

// ---------------------------------------------------------------------------------------------
// §25 — config / runtime separation on the failure path
// ---------------------------------------------------------------------------------------------
it('§25 failure-state persistence never overwrites newer user channel configuration', async () => {
  const { g, config } = await setup();
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    if (message.id === 'tg-1') throw new Error('effect failed');
  });
  // The user edits the connection while the poll is running; the failure record is written to the
  // runtime document only and must not resurrect the stale polling snapshot.
  const newer = structuredClone(config);
  newer.telegram.allowedChatIds = ['new-chat'];
  await g.saveChannelsConfig(newer);
  await g.pollChannelOnce({ config, handle });
  expect((await g.loadChannelsConfig()).telegram.allowedChatIds).toEqual(['new-chat']);
  expect(values['iris.channels.config.v1']).not.toContain('lastUpdateId');
  expect(values[runtimeKey]).toContain('"attention"');
});

// ---------------------------------------------------------------------------------------------
// §23 — duplicate / replayed Telegram approval update
// ---------------------------------------------------------------------------------------------
it('§23 a duplicated Telegram approval update settles exactly once through the channel runner', async () => {
  const { g, config } = await setup();
  await toolApprovalRepository.save(approvalRecord('approval-1'));
  // The same identity is delivered twice inside one batch, then the whole batch is replayed.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([update(1), update(1)]));
  const handle = vi.fn(async (message: IncomingChannelMessage) => {
    await resolveRemoteApproval(message.text);
  });
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('completed');
  // Transport replay may occur; semantic duplication may not.
  expect(handle).toHaveBeenCalledTimes(1);
  expect(settlement.count).toBe(1);
  expect(settlement.agentResumes).toBe(0);
  expect(settlement.projectResolutions).toBe(0);
  expect((await toolApprovalRepository.get('approval-1'))?.status).toBe('approved');
  // The replayed delivery must observe already-resolved truth rather than failing.
  await expect(resolveRemoteApproval('approve approval-1')).resolves.toMatch('already resolved.');
  expect(settlement.count).toBe(1);
});

it('escapes plain text for parse_mode HTML so an unescaped acknowledgement cannot be refused', async () => {
  const { g } = await setup();
  expect(g.escapeTelegramHtml('approve <b>&</b> rm -rf a>b')).toBe(
    'approve &lt;b&gt;&amp;&lt;/b&gt; rm -rf a&gt;b',
  );
  let body: { text?: string; parse_mode?: string } = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    body = JSON.parse(String((init as RequestInit).body)) as typeof body;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) } as Response;
  });
  const sent = await g.sendTelegramMessage({
    botToken: 'fixture-token',
    chatId: '123',
    text: 'deny <script>&',
  });
  expect(sent.ok).toBe(true);
  expect(body.parse_mode).toBe('HTML');
  expect(body.text).toBe('deny &lt;script&gt;&amp;');
});
