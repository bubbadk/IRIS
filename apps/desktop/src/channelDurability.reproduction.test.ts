import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotStorage } from './repositoryStorage';
import {
  appendChannelInbox,
  defaultChannelsConfig,
  loadChannelInbox,
  loadChannelsConfig,
  saveChannelsConfig,
} from './bridgeGateway';
// Historical evidence uses the explicit legacy Storage codec, not the native repository.

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock('./credentials', () => ({ loadProviderSecrets: vi.fn(), saveProviderSecrets: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const inboxKey = 'iris.channels.inbox.v1';
const configKey = 'iris.channels.config.v1';
const message = (id: string) => ({
  id,
  platform: 'telegram' as const,
  chatId: 'fixture',
  senderName: 'Fixture',
  text: id,
  timestamp: new Date(0).toISOString(),
});

it('reproduces original localStorage-only persistence on the explicit legacy preview path', () => {
  const storage = new SnapshotStorage();
  vi.stubGlobal('localStorage', storage);
  saveChannelsConfig(structuredClone(defaultChannelsConfig), storage);
  appendChannelInbox([message('A')], storage);
  expect(storage.getItem(configKey)).not.toBeNull();
  expect(storage.getItem(inboxKey)).not.toBeNull();
  expect(native.invoke).not.toHaveBeenCalled();
});

it('reproduces lost append with two storage contexts reading before either write', () => {
  const durable = new SnapshotStorage();
  const a = new SnapshotStorage();
  const b = new SnapshotStorage();
  // Deterministic cross-context barrier: both reads observe the same pre-write snapshot.
  const beforeA = durable.getItem(inboxKey);
  const beforeB = durable.getItem(inboxKey);
  a.getItem = () => beforeA;
  b.getItem = () => beforeB;
  a.setItem = (key, value) => durable.setItem(key, value);
  b.setItem = (key, value) => durable.setItem(key, value);
  appendChannelInbox([message('A')], a);
  appendChannelInbox([message('B')], b);
  expect(loadChannelInbox(durable).map((item) => item.id)).toEqual(['B']);
});

it('reproduces stale poll snapshot overwriting newer user configuration', () => {
  const storage = new SnapshotStorage();
  const pollingSnapshot = loadChannelsConfig(storage);
  saveChannelsConfig(
    { ...pollingSnapshot, telegram: { ...pollingSnapshot.telegram, allowedChatIds: ['new-chat'] } },
    storage,
  );
  expect(loadChannelsConfig(storage).telegram.allowedChatIds).toEqual(['new-chat']);
  // Exact whole-config write used by ChannelsWindow after getUpdates completes.
  saveChannelsConfig(
    { ...pollingSnapshot, telegram: { ...pollingSnapshot.telegram, lastUpdateId: 42 } },
    storage,
  );
  expect(loadChannelsConfig(storage).telegram.allowedChatIds).toEqual([]);
});
