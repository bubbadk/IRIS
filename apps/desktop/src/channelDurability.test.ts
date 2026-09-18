import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SnapshotStorage, RepositoryTransactions } from './repositoryStorage';
import type { StorageSnapshot } from './repositoryStorage';
import type { IncomingChannelMessage } from './bridgeGateway';

const native = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), load: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock('./credentials', () => ({
  loadProviderSecrets: native.load,
  saveProviderSecrets: native.save,
}));
const configKey = 'iris.channels.config.v1';
const inboxKey = 'iris.channels.inbox.v1';
const runtimeKey = 'iris.channels.runtime.v1';
let values: Record<string, string>;
let revisions: Record<string, number>;
let storage: SnapshotStorage;
let failCommit: ((changes: Record<string, string | null>) => boolean) | undefined;
let unavailable = false;
const message = (id: string) => ({
  id,
  platform: 'telegram' as const,
  chatId: '123',
  senderName: 'Fixture',
  text: id,
  timestamp: new Date(0).toISOString(),
});
const update = (id: number) => ({
  update_id: id,
  message: { chat: { id: 123 }, text: `approve ${id}`, date: 1 },
});
const response = (result: unknown[]) =>
  ({ ok: true, json: async () => ({ ok: true, result }) }) as Response;
async function gateway() {
  return import('./bridgeGateway');
}
async function setupPoll() {
  const g = await gateway();
  await g.migrateChannels();
  const config = structuredClone(g.defaultChannelsConfig);
  config.telegram = {
    ...config.telegram,
    enabled: true,
    botToken: 'fixture-token',
    allowedChatIds: ['123'],
  };
  const handle = vi.fn().mockResolvedValue(undefined);
  return { g, config, handle };
}

beforeEach(() => {
  vi.resetModules();
  values = {};
  revisions = {};
  failCommit = undefined;
  unavailable = false;
  storage = new SnapshotStorage();
  vi.stubGlobal('localStorage', storage);
  native.save.mockReset().mockResolvedValue(true);
  native.load.mockReset().mockResolvedValue(null);
  native.invoke
    .mockReset()
    .mockImplementation(
      async (
        command: string,
        args: { expected?: Record<string, number>; changes?: Record<string, string | null> },
      ) => {
        if (unavailable) throw new Error('Repository unavailable');
        if (command === 'repository_initialize') return;
        if (command === 'process_own_pid') return 4242;
        if (command === 'process_is_alive') return { status: 'dead' };
        if (command === 'repository_snapshot')
          return { values: { ...values }, revisions: { ...revisions } };
        if (command === 'repository_commit') {
          const changes = args.changes!;
          if (failCommit?.(changes)) throw new Error('Commit failed');
          if (
            Object.entries(args.expected!).some(
              ([key, revision]) => (revisions[key] ?? 0) !== revision,
            )
          )
            return false;
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) delete values[key];
            else values[key] = value;
            revisions[key] = (revisions[key] ?? 0) + 1;
          }
          return true;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('migrates once, strips secrets, commits before cleanup, and repository wins after restart', async () => {
  const g = await gateway();
  storage.setItem(
    configKey,
    JSON.stringify({
      telegram: { enabled: true, botToken: 'legacy', allowedChatIds: ['123'], lastUpdateId: 7 },
      discord: {},
    }),
  );
  storage.setItem(inboxKey, JSON.stringify([message('tg-1')]));
  const remove = vi.spyOn(storage, 'removeItem').mockImplementation((key) => {
    expect(values[runtimeKey]).toBeDefined();
    SnapshotStorage.prototype.removeItem.call(storage, key);
  });
  await g.migrateChannels();
  expect(native.save).toHaveBeenCalledWith('iris-channels-connection', { telegramToken: 'legacy' });
  expect(values[configKey]).not.toContain('legacy');
  expect(values[configKey]).not.toContain('lastUpdateId');
  expect(JSON.parse(values[runtimeKey]).lastUpdateId).toBe(7);
  expect(remove).toHaveBeenCalledTimes(2);
  storage.setItem(configKey, 'corrupt stale backup');
  storage.setItem(inboxKey, JSON.stringify([message('obsolete')]));
  vi.resetModules();
  const restarted = await gateway();
  expect((await restarted.loadChannelInbox()).map((m) => m.id)).toEqual(['tg-1']);
  expect((await restarted.loadChannelsConfig()).telegram.allowedChatIds).toEqual(['123']);
  expect(native.save).toHaveBeenCalledTimes(1);
});

it.each(['keyring', 'commit'])(
  'retains legacy data and no marker when %s fails, then retries safely',
  async (failure) => {
    const g = await gateway();
    const raw = JSON.stringify({ telegram: { botToken: 'legacy' }, discord: {} });
    storage.setItem(configKey, raw);
    storage.setItem(inboxKey, JSON.stringify([message('a')]));
    if (failure === 'keyring') native.save.mockRejectedValueOnce(new Error('Keyring unavailable'));
    else failCommit = () => true;
    await expect(g.migrateChannels()).rejects.toThrow();
    expect(storage.getItem(configKey)).toBe(raw);
    expect(values[runtimeKey]).toBeUndefined();
    failCommit = undefined;
    await g.migrateChannels();
    expect(JSON.parse(values[inboxKey])).toHaveLength(1);
  },
);

it('restarts safely after successful migration but failed legacy cleanup', async () => {
  const g = await gateway();
  storage.setItem(inboxKey, JSON.stringify([message('a')]));
  const remove = vi.spyOn(storage, 'removeItem').mockImplementationOnce(() => {
    throw new Error('Cleanup failed');
  });
  await expect(g.migrateChannels()).rejects.toThrow('Cleanup failed');
  expect(values[runtimeKey]).toBeDefined();
  remove.mockRestore();
  vi.resetModules();
  await (await gateway()).migrateChannels();
  expect(JSON.parse(values[inboxKey])).toHaveLength(1);
  expect(storage.getItem(inboxKey)).toBeNull();
});

it.each([
  [configKey, '{'],
  [configKey, '[]'],
  [configKey, '{"telegram":{"enabled":"yes"}}'],
  [inboxKey, '{'],
  [inboxKey, '{}'],
  [inboxKey, '[{"id":"invalid"}]'],
  [inboxKey, JSON.stringify([message('same'), message('same')])],
])('fails closed during migration of corrupt %s (%s)', async (key, raw) => {
  const g = await gateway();
  storage.setItem(key, raw);
  await expect(g.migrateChannels()).rejects.toThrow('Existing data was retained');
  expect(storage.getItem(key)).toBe(raw);
  expect(values[runtimeKey]).toBeUndefined();
  expect(native.save).not.toHaveBeenCalled();
});

it('fails closed rather than overwriting corrupt durable inbox or runtime', async () => {
  const g = await gateway();
  await g.migrateChannels();
  values[inboxKey] = 'invalid';
  await expect(g.appendChannelInbox([message('new')])).rejects.toThrow(
    'Existing data was retained',
  );
  expect(values[inboxKey]).toBe('invalid');
  values[inboxKey] = '[]';
  values[runtimeKey] = '{"version":1,"lastUpdateId":-1}';
  await expect(g.loadChannelInbox()).rejects.toThrow('Existing data was retained');
});

it('legacy append rejects invalid caller messages and retains the previous inbox', async () => {
  const g = await gateway();
  storage.setItem(inboxKey, JSON.stringify([message('good')]));
  const poison = { ...message('bad'), timestamp: 123 } as unknown as IncomingChannelMessage;
  expect(() => g.appendChannelInbox([message('next'), poison], storage)).toThrow(
    'Existing data was retained',
  );
  expect(
    JSON.parse(storage.getItem(inboxKey)!)
      .map((m: { id: string }) => m.id)
      .sort(),
  ).toEqual(['good']);
  expect(
    g
      .appendChannelInbox([message('next')], storage)
      .map((m) => m.id)
      .sort(),
  ).toEqual(['good', 'next']);
});

it('CAS barrier: A reads, B reads, A commits, B retries append; both messages survive', async () => {
  const g = await gateway();
  let release!: () => void;
  let reads = 0;
  let revision = 0;
  let data: Record<string, string> = {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const backend = {
    async snapshot(): Promise<StorageSnapshot> {
      const snapshot = { values: { ...data }, revisions: { [inboxKey]: revision } };
      reads++;
      if (reads <= 2) {
        events.push(`${reads === 1 ? 'A' : 'B'} reads`);
        if (reads === 2) release();
        await barrier;
      }
      return snapshot;
    },
    async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
      if (expected[inboxKey] !== revision) {
        events.push('B conflicts');
        return false;
      }
      revision++;
      data = { ...data, [inboxKey]: changes[inboxKey]! };
      events.push(revision === 1 ? 'A appends' : 'B appends');
      return true;
    },
  };
  const a = new RepositoryTransactions(backend);
  const b = new RepositoryTransactions(backend);
  await Promise.all([
    a.run((view) => g.createChannelRepository(view).append([message('A')]), [inboxKey]),
    b.run((view) => g.createChannelRepository(view).append([message('B')]), [inboxKey]),
  ]);
  expect(events).toEqual(['A reads', 'B reads', 'A appends', 'B conflicts', 'B appends']);
  expect(
    JSON.parse(data[inboxKey])
      .map((m: { id: string }) => m.id)
      .sort(),
  ).toEqual(['A', 'B']);
});

it('native default append persists through restart and deduplicates identities', async () => {
  const g = await gateway();
  await g.appendChannelInbox([message('A')]);
  await g.appendChannelInbox([message('A'), message('B')]);
  expect(storage.getItem(inboxKey)).toBeNull();
  vi.resetModules();
  expect((await (await gateway()).loadChannelInbox()).map((m) => m.id).sort()).toEqual(['A', 'B']);
});

it('only one poll runs while fetch is blocked and stale poll never writes user config', async () => {
  const { g, config, handle } = await setupPoll();
  let release!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const running = g.pollChannelOnce({ config, handle });
  await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
  expect(await g.pollChannelOnce({ config, handle })).toEqual({ status: 'skipped' });
  const newer = structuredClone(config);
  newer.telegram.allowedChatIds = ['new-chat'];
  await g.saveChannelsConfig(newer);
  release(response([update(1)]));
  expect((await running).status).toBe('completed');
  expect((await g.loadChannelsConfig()).telegram.allowedChatIds).toEqual(['new-chat']);
  expect(JSON.parse(values[runtimeKey]).lastUpdateId).toBe(2);
  expect(values[configKey]).not.toContain('lastUpdateId');
});

it.each([
  'network throw',
  'non-2xx',
  'malformed JSON',
  'malformed update',
  'repository unavailable',
])('poll handles %s without rejection and releases its guard', async (failure) => {
  const { g, config, handle } = await setupPoll();
  const fetch = vi.spyOn(globalThis, 'fetch');
  if (failure === 'network throw') fetch.mockRejectedValueOnce(new Error('offline'));
  if (failure === 'non-2xx')
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: true, result: [update(1)] }),
    } as Response);
  if (failure === 'malformed JSON')
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('JSON');
      },
    } as unknown as Response);
  if (failure === 'malformed update')
    fetch.mockResolvedValueOnce(response([{ update_id: 1, message: null }]));
  if (failure === 'repository unavailable') unavailable = true;
  expect(['failed', 'blocked']).toContain((await g.pollChannelOnce({ config, handle })).status);
  expect(handle).not.toHaveBeenCalled();
  expect(JSON.parse(values[runtimeKey]).lastUpdateId).toBe(0);
  unavailable = false;
  fetch.mockResolvedValue(response([update(1)]));
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(handle).toHaveBeenCalledTimes(1);
});

it('records an unknown effect outcome durably on handler throw and never replays it after restart', async () => {
  const { g, config, handle } = await setupPoll();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([update(1), update(2), update(3)]));
  handle.mockImplementation(async (message) => {
    if (message.id === 'tg-2') throw new Error('effect failed');
  });
  const first = await g.pollChannelOnce({ config, handle });
  expect(first).toMatchObject({ status: 'completed' });
  expect(first.error).toContain('Channel update 2 needs attention');
  // The failure is classified after update 2 and later updates still progress in the same poll.
  expect(handle.mock.calls.map((call) => call[0].id)).toEqual(['tg-1', 'tg-2', 'tg-3']);
  const durable = JSON.parse(values[runtimeKey]);
  expect(durable).toEqual({
    version: 2,
    lastUpdateId: 4,
    attention: [
      {
        updateId: 2,
        outcome: 'unknown',
        attempts: 1,
        reason: 'The effect outcome could not be determined, so it was not replayed automatically.',
        at: expect.any(Number),
      },
    ],
  });
  // Transport advanced only together with the truth record; the update is never called successful.
  vi.resetModules();
  const restarted = await gateway();
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(handle.mock.calls.filter((call) => call[0].id === 'tg-2')).toHaveLength(1);
  expect(JSON.parse(values[runtimeKey]).attention).toHaveLength(1);
});

it('preserves an uncheckpointed effect claim across restart, recovers it, and never replays the effect', async () => {
  const { g, config, handle } = await setupPoll();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([update(1), update(2), update(3)]));
  // The effect for update 2 resolves, but its durable completion commit is rejected.
  failCommit = (changes) =>
    !!changes[runtimeKey] && JSON.parse(changes[runtimeKey]!).lastUpdateId === 3;
  expect(await g.pollChannelOnce({ config, handle })).toMatchObject({
    status: 'uncertain',
    updateId: 2,
  });
  expect(handle.mock.calls.map((call) => call[0].id)).toEqual(['tg-1', 'tg-2']);
  expect(JSON.parse(values[runtimeKey])).toMatchObject({
    version: 2,
    lastUpdateId: 2,
    pending: { updateId: 2, replay: 'unsafe', effect: true, attempts: 1 },
  });
  // A full restart reconciles the claim from durable evidence alone instead of latching the channel.
  failCommit = undefined;
  vi.resetModules();
  const restarted = await gateway();
  expect((await restarted.pollChannelOnce({ config, handle })).status).toBe('completed');
  expect(handle.mock.calls.filter((call) => call[0].id === 'tg-2')).toHaveLength(1);
  expect(handle.mock.calls.map((call) => call[0].id)).toEqual(['tg-1', 'tg-2', 'tg-3']);
  expect(JSON.parse(values[runtimeKey])).toMatchObject({
    version: 2,
    lastUpdateId: 4,
    attention: [expect.objectContaining({ updateId: 2, outcome: 'unknown' })],
  });
});

it('checkpoints a safe prefix but never advances beyond unknown update; duplicated batch does not replay prefix', async () => {
  const { g, config, handle } = await setupPoll();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    response([update(1), { update_id: 2, callback_query: {} }, update(3)]),
  );
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('blocked');
  expect(JSON.parse(values[runtimeKey]).lastUpdateId).toBe(2);
  expect((await g.pollChannelOnce({ config, handle })).status).toBe('blocked');
  expect(handle).toHaveBeenCalledTimes(1);
});

it('deduplicates a batch and repeated batches with per-update durable progression', async () => {
  const { g, config, handle } = await setupPoll();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([update(1), update(1), update(2)]));
  await g.pollChannelOnce({ config, handle });
  await g.pollChannelOnce({ config, handle });
  expect(handle).toHaveBeenCalledTimes(2);
  expect(JSON.parse(values[runtimeKey]).lastUpdateId).toBe(3);
  expect(JSON.parse(values[inboxKey])).toHaveLength(2);
});
