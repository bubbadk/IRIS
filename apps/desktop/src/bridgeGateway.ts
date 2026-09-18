import { loadProviderSecrets, saveProviderSecrets } from './credentials';
import { withStorageWrite } from './storageWrites';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createDesktopRepository } from './repositoryStorage';
import { isPlainRecord, readPersistedArray, readPersistedValue } from './persistenceIntegrity';

export type ChannelPlatform = 'telegram' | 'discord' | 'slack';

export type TelegramConfig = {
  enabled: boolean;
  botToken: string;
  allowedChatIds: string[];
  lastUpdateId: number;
};

export type DiscordConfig = {
  enabled: boolean;
  webhookUrl: string;
  botToken?: string;
  channelId?: string;
};

export type ChannelsConfig = {
  telegram: TelegramConfig;
  discord: DiscordConfig;
};

export const defaultChannelsConfig: ChannelsConfig = {
  telegram: {
    enabled: false,
    botToken: '',
    allowedChatIds: [],
    lastUpdateId: 0,
  },
  discord: {
    enabled: false,
    webhookUrl: '',
  },
};

const CHANNELS_STORAGE_KEY = 'iris.channels.config.v1';
const CHANNEL_INBOX_STORAGE_KEY = 'iris.channels.inbox.v1';

const CHANNEL_RUNTIME_STORAGE_KEY = 'iris.channels.runtime.v1';
const channelKeys = [CHANNELS_STORAGE_KEY, CHANNEL_INBOX_STORAGE_KEY, CHANNEL_RUNTIME_STORAGE_KEY];

function decodeConfig(value: unknown): ChannelsConfig | null {
  if (!isPlainRecord(value)) return null;
  const telegram = value.telegram ?? {};
  const discord = value.discord ?? {};
  if (!isPlainRecord(telegram) || !isPlainRecord(discord)) return null;
  if (
    (telegram.enabled !== undefined && typeof telegram.enabled !== 'boolean') ||
    (telegram.allowedChatIds !== undefined &&
      (!Array.isArray(telegram.allowedChatIds) ||
        !telegram.allowedChatIds.every((id: unknown) => typeof id === 'string'))) ||
    (telegram.lastUpdateId !== undefined && !validOffset(telegram.lastUpdateId)) ||
    (telegram.botToken !== undefined && typeof telegram.botToken !== 'string') ||
    (discord.enabled !== undefined && typeof discord.enabled !== 'boolean') ||
    ['webhookUrl', 'botToken', 'channelId'].some(
      (key) => discord[key] !== undefined && typeof discord[key] !== 'string',
    )
  )
    return null;
  return {
    telegram: { ...defaultChannelsConfig.telegram, ...telegram, botToken: '' },
    discord: { ...defaultChannelsConfig.discord, ...discord, webhookUrl: '', botToken: '' },
  } as ChannelsConfig;
}

function validOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Legacy/browser-preview storage codec. Native callers use channelRepository instead. */
export function loadChannelsConfig(): Promise<ChannelsConfig>;
export function loadChannelsConfig(storage: Storage): ChannelsConfig;
export function loadChannelsConfig(storage?: Storage): ChannelsConfig | Promise<ChannelsConfig> {
  if (!storage) return migrateChannels().then(() => channelRepository.config());
  return (
    readPersistedValue({
      repository: 'channel config',
      storageKey: CHANNELS_STORAGE_KEY,
      raw: storage.getItem(CHANNELS_STORAGE_KEY),
      decode: decodeConfig,
    }) ?? structuredClone(defaultChannelsConfig)
  );
}

export function saveChannelsConfig(config: ChannelsConfig): Promise<void>;
export function saveChannelsConfig(config: ChannelsConfig, storage: Storage): void;
export function saveChannelsConfig(
  config: ChannelsConfig,
  storage?: Storage,
): void | Promise<void> {
  if (!storage) return migrateChannels().then(() => channelRepository.saveConfig(config));
  loadChannelsConfig(storage);
  storage.setItem(
    CHANNELS_STORAGE_KEY,
    JSON.stringify({
      telegram: {
        enabled: config.telegram.enabled,
        allowedChatIds: config.telegram.allowedChatIds,
        lastUpdateId: config.telegram.lastUpdateId,
      },
      discord: { enabled: config.discord.enabled, channelId: config.discord.channelId },
    }),
  );
}

const channelSecretId = 'iris-channels-connection';

export async function loadChannelConnection(storage?: Storage): Promise<ChannelsConfig> {
  if (!storage && isTauri()) {
    await migrateChannels();
    const config = await channelRepository.config();
    const secrets = (await loadProviderSecrets(channelSecretId)) ?? {};
    return {
      telegram: { ...config.telegram, botToken: secrets.telegramToken ?? '' },
      discord: {
        ...config.discord,
        webhookUrl: secrets.discordWebhook ?? '',
        botToken: secrets.discordToken ?? '',
      },
    };
  }
  storage ??= globalThis.localStorage;
  const legacyStorage = storage;
  return withStorageWrite(legacyStorage, async () => {
    const storage = legacyStorage;
    const config = loadChannelsConfig(storage);
    const raw = storage.getItem(CHANNELS_STORAGE_KEY);
    const legacy = raw ? (JSON.parse(raw) as Partial<ChannelsConfig>) : {};
    const stored = (await loadProviderSecrets(channelSecretId)) ?? {};
    const oldSecrets = {
      telegramToken: legacy.telegram?.botToken,
      discordWebhook: legacy.discord?.webhookUrl,
      discordToken: legacy.discord?.botToken,
    };
    const secrets = { ...stored };
    let migrating = false;
    for (const [key, value] of Object.entries(oldSecrets)) {
      if (typeof value === 'string' && value) {
        secrets[key] ??= value;
        migrating = true;
      }
    }
    if (migrating) {
      const durable = await saveProviderSecrets(channelSecretId, secrets);
      if (!durable)
        throw new Error(
          'Open the native desktop app to migrate existing channel credentials into the OS credential store. The original values have been preserved.',
        );
      saveChannelsConfig(config, storage);
    }
    return {
      telegram: { ...config.telegram, botToken: secrets.telegramToken ?? '' },
      discord: {
        ...config.discord,
        webhookUrl: secrets.discordWebhook ?? '',
        botToken: secrets.discordToken ?? '',
      },
    };
  });
}

export async function saveChannelConnection(
  config: ChannelsConfig,
  storage?: Storage,
): Promise<boolean> {
  if (!storage && isTauri()) {
    await migrateChannels();
    const durable = await saveProviderSecrets(channelSecretId, {
      telegramToken: config.telegram.botToken,
      discordWebhook: config.discord.webhookUrl,
      discordToken: config.discord.botToken ?? '',
    });
    if (!durable) throw new Error('Channel credentials could not be saved durably.');
    await channelRepository.saveConfig(config);
    return true;
  }
  const previewStorage = storage ?? globalThis.localStorage;
  return withStorageWrite(previewStorage, async () => {
    const durable = await saveProviderSecrets(channelSecretId, {
      telegramToken: config.telegram.botToken,
      discordWebhook: config.discord.webhookUrl,
      discordToken: config.discord.botToken ?? '',
    });
    saveChannelsConfig(config, previewStorage);
    return durable;
  });
}

export type IncomingChannelMessage = {
  id: string;
  platform: ChannelPlatform;
  chatId: string;
  senderName: string;
  text: string;
  timestamp: string;
};

export function loadChannelInbox(): Promise<IncomingChannelMessage[]>;
export function loadChannelInbox(storage: Storage): IncomingChannelMessage[];
export function loadChannelInbox(
  storage?: Storage,
): IncomingChannelMessage[] | Promise<IncomingChannelMessage[]> {
  if (!storage) return loadDurableChannelInbox();
  return readPersistedArray({
    repository: 'channel inbox',
    storageKey: CHANNEL_INBOX_STORAGE_KEY,
    raw: storage.getItem(CHANNEL_INBOX_STORAGE_KEY),
    identity: (item) => item.id,
    decode: (item) =>
      isPlainRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.chatId === 'string' &&
      typeof item.senderName === 'string' &&
      typeof item.text === 'string' &&
      typeof item.timestamp === 'string' &&
      Number.isFinite(Date.parse(item.timestamp)) &&
      (item.platform === 'telegram' || item.platform === 'discord' || item.platform === 'slack')
        ? (item as IncomingChannelMessage)
        : null,
  });
}

export function appendChannelInbox(
  messages: IncomingChannelMessage[],
): Promise<IncomingChannelMessage[]>;
export function appendChannelInbox(
  messages: IncomingChannelMessage[],
  storage: Storage,
): IncomingChannelMessage[];
export function appendChannelInbox(
  messages: IncomingChannelMessage[],
  storage?: Storage,
): IncomingChannelMessage[] | Promise<IncomingChannelMessage[]> {
  if (!storage) return migrateChannels().then(() => channelRepository.append(messages));
  const incoming = new Map(messages.map((message) => [message.id, message]));
  // Validate caller data too: a bad append must not poison a previously valid inbox.
  const checked = loadChannelInbox({
    getItem: () => JSON.stringify([...incoming.values()]),
  } as unknown as Storage);
  const next = [...checked, ...loadChannelInbox(storage).filter((old) => !incoming.has(old.id))]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 100);
  storage.setItem(CHANNEL_INBOX_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Bounded automatic replay budget for one channel effect. Reaching it is itself durable evidence:
 * the update is classified as poison instead of being retried forever. */
export const CHANNEL_EFFECT_MAX_ATTEMPTS = 3;
/** Minimum delay between automatic replays, so crash recovery cannot spin. */
export const CHANNEL_EFFECT_RETRY_BACKOFF_MS = 30_000;
/** Needs-attention evidence is bounded so the runtime document cannot grow without limit. */
export const CHANNEL_ATTENTION_LIMIT = 20;
/**
 * How long a claim stays valid without the owner renewing it. A claim older than this is treated as
 * abandoned, which is what makes a crashed runtime recoverable. The owner renews it while an effect
 * runs (see `startClaimHeartbeat`), so a live-but-slow runtime is never mistaken for a dead one.
 */
export const CHANNEL_CLAIM_LEASE_MS = 30_000;
/** Renewal period; three renewals fit inside one lease so a single slow write cannot lose a claim. */
export const CHANNEL_CLAIM_HEARTBEAT_MS = 10_000;

/**
 * A handler declares this when a bounded replay of its effect cannot duplicate a durable semantic
 * result: either the effect provably never started, or the authoritative layer already deduplicates
 * it (idempotency key, compare-and-set settlement, or execution admission).
 */
export class ChannelEffectRetryableError extends Error {
  constructor() {
    super('Channel effect replay is safe and bounded.');
    this.name = 'ChannelEffectRetryableError';
  }
}

/**
 * A handler declares this when the semantic effect durably completed and only a later
 * acknowledgement or cleanup step failed. The effect must never be replayed.
 */
export class ChannelEffectCompletedError extends Error {
  constructor() {
    super('Channel effect completed; a later step failed.');
    this.name = 'ChannelEffectCompletedError';
  }
}

/**
 * Durable, non-blocking evidence of an update that did not complete its semantic effect. Transport
 * may advance past it (see `finalize`), but it is preserved for diagnosis and never reported as a
 * success.
 */
export type ChannelUpdateAttention = {
  updateId: number;
  /**
   * `unknown` — the effect may or may not have run; automatic replay is refused.
   * `poison` — the effect did not start and the bounded replay budget is exhausted.
   * `completed-with-warning` — the effect durably completed; a later acknowledgement failed.
   */
  outcome: 'unknown' | 'poison' | 'completed-with-warning';
  attempts: number;
  /** Fixed, secret-free classification text; never raw handler or API output. */
  reason: string;
  at: number;
};

/** One write-ahead claim, with the durable evidence needed to recover it after a crash. */
export type ChannelPendingUpdate = {
  updateId: number;
  /**
   * `safe` — durable evidence says the effect never started (or an idempotent replay is declared);
   * `unsafe` — the effect may have run, so a restart must never replay it on its own.
   */
  replay: 'safe' | 'unsafe';
  /** False for a filtered update that carries no semantic effect at all. */
  effect: boolean;
  attempts: number;
  attemptedAt: number;
  /**
   * The JS runtime that owns this claim. Two IRIS instances share one repository, so a claim is
   * advanced only by its owner; a foreign claim needs proven abandonment first.
   */
  owner: string;
  /** The owning OS process, when the host can report one. Used for the tri-state liveness probe. */
  ownerPid: number | null;
  /** Epoch ms of the last ownership heartbeat; `now - ownerAt` is the lease age. */
  ownerAt: number;
};

export type ChannelRuntime = {
  version: 2;
  /** Next Telegram transport offset. Transport progress is NOT proof of semantic success. */
  lastUpdateId: number;
  pending?: ChannelPendingUpdate;
  /** Newest-first terminal classification of updates that did not complete semantically. */
  attention?: ChannelUpdateAttention[];
};

const CHANNEL_ATTENTION_OUTCOMES = ['unknown', 'poison', 'completed-with-warning'] as const;

function decodeAttention(value: unknown): ChannelUpdateAttention[] | null {
  if (!Array.isArray(value) || value.length > CHANNEL_ATTENTION_LIMIT) return null;
  for (const entry of value) {
    if (
      !isPlainRecord(entry) ||
      !validOffset(entry.updateId) ||
      !validOffset(entry.attempts) ||
      !validOffset(entry.at) ||
      typeof entry.reason !== 'string' ||
      entry.reason.length === 0 ||
      entry.reason.length > 200 ||
      !CHANNEL_ATTENTION_OUTCOMES.includes(
        entry.outcome as (typeof CHANNEL_ATTENTION_OUTCOMES)[number],
      )
    )
      return null;
  }
  return value as ChannelUpdateAttention[];
}

/**
 * Reads the runtime document and normalizes the legacy `version: 1` shape.
 *
 * A version 1 document could only express "a write-ahead claim whose outcome is uncertain", so it
 * is adopted as an unreplayable in-flight effect. That is exactly the durable evidence an older
 * process left behind, and it lets an already-wedged install recover instead of staying latched.
 */
function loadRuntime(storage: Storage): ChannelRuntime | null {
  return readPersistedValue({
    repository: 'channel runtime',
    storageKey: CHANNEL_RUNTIME_STORAGE_KEY,
    raw: storage.getItem(CHANNEL_RUNTIME_STORAGE_KEY),
    decode: (value) => {
      if (!isPlainRecord(value) || !validOffset(value.lastUpdateId)) return null;
      if (value.version === 1) {
        if (value.pending === undefined) return { version: 2, lastUpdateId: value.lastUpdateId };
        const pending = value.pending;
        if (
          !isPlainRecord(pending) ||
          !validOffset(pending.updateId) ||
          pending.updateId < value.lastUpdateId ||
          pending.outcome !== 'uncertain'
        )
          return null;
        return {
          version: 2,
          lastUpdateId: value.lastUpdateId,
          pending: {
            updateId: pending.updateId,
            replay: 'unsafe',
            effect: true,
            attempts: 1,
            attemptedAt: 0,
            owner: '',
            ownerPid: null,
            ownerAt: 0,
          },
        };
      }
      if (value.version !== 2) return null;
      if (value.pending !== undefined) {
        const pending = value.pending;
        if (
          !isPlainRecord(pending) ||
          !validOffset(pending.updateId) ||
          pending.updateId < value.lastUpdateId ||
          (pending.replay !== 'safe' && pending.replay !== 'unsafe') ||
          typeof pending.effect !== 'boolean' ||
          !validOffset(pending.attempts) ||
          pending.attempts < 1 ||
          !validOffset(pending.attemptedAt) ||
          (pending.owner !== undefined && typeof pending.owner !== 'string') ||
          (pending.ownerPid !== undefined &&
            pending.ownerPid !== null &&
            !(validOffset(pending.ownerPid) && pending.ownerPid > 0)) ||
          (pending.ownerAt !== undefined && !validOffset(pending.ownerAt))
        )
          return null;
        // Ownership metadata is normalized, never trusted: an unowned or unsigned claim reads as a
        // foreign claim with an expired lease, which is exactly the fail-closed recovery reading.
        const ownership = {
          owner: typeof pending.owner === 'string' ? pending.owner : '',
          ownerPid: typeof pending.ownerPid === 'number' ? pending.ownerPid : null,
          ownerAt: validOffset(pending.ownerAt) ? pending.ownerAt : 0,
        };
        pending.owner = ownership.owner;
        pending.ownerPid = ownership.ownerPid;
        pending.ownerAt = ownership.ownerAt;
      }
      if (value.attention !== undefined && decodeAttention(value.attention) === null) return null;
      return value as unknown as ChannelRuntime;
    },
  });
}

/** Pure transaction operations only; credentials, network and handlers never run inside CAS retries.
 * Browser preview uses localStorage (single-key atomic writes, not a durable multi-key database).
 */
export function createChannelRepository(storage: Storage = globalThis.localStorage) {
  return {
    async config() {
      return loadChannelsConfig(storage);
    },
    async runtime() {
      return loadRuntime(storage);
    },
    async inbox() {
      return loadChannelInbox(storage);
    },
    async migrationSource() {
      const runtime = loadRuntime(storage);
      const config = loadChannelsConfig(storage);
      loadChannelInbox(storage);
      return {
        migrated: runtime !== null,
        configRaw: storage.getItem(CHANNELS_STORAGE_KEY),
        config,
      };
    },
    async migrate(legacyConfig: string | null, legacyInbox: string | null) {
      const runtime = loadRuntime(storage);
      if (runtime) return;
      const currentConfig = storage.getItem(CHANNELS_STORAGE_KEY);
      const currentInbox = storage.getItem(CHANNEL_INBOX_STORAGE_KEY);
      const configStorage = { getItem: () => currentConfig ?? legacyConfig } as unknown as Storage;
      const config = loadChannelsConfig(configStorage);
      const inbox = loadChannelInbox({
        getItem: () => currentInbox ?? legacyInbox,
      } as unknown as Storage);
      // The preview's legacy credential migration owns config scrubbing. Never race
      // it by deleting secrets before the credential-store write has succeeded.
      if (isTauri()) await this.saveConfig(config);
      storage.setItem(CHANNEL_INBOX_STORAGE_KEY, JSON.stringify(inbox));
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({ version: 2, lastUpdateId: config.telegram.lastUpdateId }),
      );
    },
    async saveConfig(config: ChannelsConfig) {
      loadChannelsConfig(storage); // Refuse to overwrite a corrupt document.
      const metadata = {
        telegram: {
          enabled: config.telegram.enabled,
          allowedChatIds: config.telegram.allowedChatIds,
        },
        discord: { enabled: config.discord.enabled, channelId: config.discord.channelId },
      };
      readPersistedValue({
        repository: 'channel config',
        storageKey: CHANNELS_STORAGE_KEY,
        raw: JSON.stringify(metadata),
        decode: decodeConfig,
      });
      storage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(metadata));
    },
    async append(messages: IncomingChannelMessage[]) {
      return appendChannelInbox(messages, storage);
    },
    async claim(updateId: number, message: IncomingChannelMessage | undefined, owner: ChannelClaimOwner) {
      const runtime = loadRuntime(storage);
      if (!runtime) throw new Error('Channel storage has not been migrated.');
      if (runtime.pending || updateId < runtime.lastUpdateId) return false;
      // A terminally classified update is never re-executed, even if transport replays it.
      if (runtime.attention?.some((entry) => entry.updateId === updateId)) return false;
      // Commit inbox plus claim atomically in native runtime, before semantic effects.
      if (message) appendChannelInbox([message], storage);
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({
          ...runtime,
          pending: {
            updateId,
            // The effect has not started yet: durable evidence still permits a replay.
            replay: 'safe',
            effect: message !== undefined,
            attempts: 1,
            attemptedAt: Date.now(),
            owner: owner.token,
            ownerPid: owner.pid,
            ownerAt: Date.now(),
          },
        }),
      );
      return true;
    },
    /** Pure read of the durable claim, so the caller can decide outside the CAS retry boundary. */
    async pendingClaim(): Promise<ChannelPendingUpdate | null> {
      return loadRuntime(storage)?.pending ?? null;
    },
    /**
     * Atomically assumes ownership of a foreign claim whose abandonment the caller established.
     * Refuses (returns null) when the claim changed since that decision — a concurrent owner kept
     * working — and the caller simply re-evaluates on the next poll. The commit depends on the read
     * revision, so exactly one contender can take over.
     */
    async takeover(
      updateId: number,
      expected: { owner: string; ownerAt: number },
      owner: ChannelClaimOwner,
    ): Promise<ChannelPendingUpdate | null> {
      const runtime = loadRuntime(storage);
      const pending = runtime?.pending;
      if (!pending || pending.updateId !== updateId) return null;
      if (pending.owner === owner.token) return pending;
      if (pending.owner !== expected.owner || pending.ownerAt !== expected.ownerAt) return null;
      const next = {
        ...pending,
        owner: owner.token,
        ownerPid: owner.pid,
        ownerAt: Date.now(),
      };
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({ ...runtime, pending: next }),
      );
      return next;
    },
    /** Ownership heartbeat: keeps a live claim valid while its effect runs. */
    async renewClaim(updateId: number, owner: string): Promise<boolean> {
      const runtime = loadRuntime(storage);
      if (!runtime?.pending || runtime.pending.updateId !== updateId) return false;
      if (runtime.pending.owner !== owner) return false;
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({
          ...runtime,
          pending: { ...runtime.pending, ownerAt: Date.now() },
        }),
      );
      return true;
    },
    /**
     * Durable effect-start marker. Once committed, a restart can no longer assume the effect was
     * absent, so `pollChannelOnce` refuses to replay it from durable evidence alone. The write is
     * fenced by ownership: a runtime whose claim was taken over gets `null` and must not run the
     * effect, which is what keeps a takeover from producing duplicate execution.
     * Returns the pre-marker claim (its attempt count) so the caller can bound the replay budget.
     */
    async markEffectStarted(updateId: number, owner: string): Promise<ChannelPendingUpdate | null> {
      const runtime = loadRuntime(storage);
      if (!runtime || runtime.pending?.updateId !== updateId) return null;
      if (runtime.pending.owner !== owner) return null;
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({
          ...runtime,
          pending: { ...runtime.pending, replay: 'unsafe' as const, ownerAt: Date.now() },
        }),
      );
      return runtime.pending;
    },
    /** Persists a bounded, declared-safe replay: attempts and the backoff timestamp survive restart. */
    async scheduleRetry(updateId: number, attempts: number, owner: string): Promise<boolean> {
      const runtime = loadRuntime(storage);
      if (!runtime || runtime.pending?.updateId !== updateId) return false;
      if (runtime.pending.owner !== owner) return false;
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({
          ...runtime,
          pending: {
            ...runtime.pending,
            replay: 'safe' as const,
            attempts,
            attemptedAt: Date.now(),
          },
        }),
      );
      return true;
    },
    async complete(updateId: number, owner: string) {
      const runtime = loadRuntime(storage);
      if (!runtime || runtime.pending?.updateId !== updateId)
        throw new Error('Channel update claim is unavailable.');
      if (runtime.pending.owner !== owner)
        throw new Error('Channel update claim is owned by another runtime.');
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          lastUpdateId: updateId + 1,
          // Needs-attention evidence outlives the update that produced it.
          ...(runtime.attention?.length ? { attention: runtime.attention } : {}),
        }),
      );
    },
    /**
     * One atomic commit that records a truthful terminal classification and advances transport past
     * the update. Because the record and the advance are the same commit, a crash can never observe
     * an advanced cursor without the classification that justifies it, and no failure is ever
     * written as a success.
     */
    async finalize(updateId: number, owner: string, entry?: ChannelUpdateAttention) {
      const runtime = loadRuntime(storage);
      if (!runtime) throw new Error('Channel storage has not been migrated.');
      // The loser of a takeover must never clear or overwrite the winner's claim.
      if (
        runtime.pending &&
        runtime.pending.updateId === updateId &&
        runtime.pending.owner !== owner
      )
        return false;
      const attention = entry
        ? [entry, ...(runtime.attention ?? [])].slice(0, CHANNEL_ATTENTION_LIMIT)
        : runtime.attention;
      const pending = runtime.pending?.updateId === updateId ? undefined : runtime.pending;
      storage.setItem(
        CHANNEL_RUNTIME_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          lastUpdateId: Math.max(runtime.lastUpdateId, updateId + 1),
          ...(pending ? { pending } : {}),
          ...(attention?.length ? { attention } : {}),
        }),
      );
      return true;
    },
  };
}

export const channelRepository = createDesktopRepository(createChannelRepository, channelKeys);

/** Repository runtime presence is the migration marker, committed with config and inbox.
 * Cleanup is deliberately after the native transaction and can safely repeat after a restart.
 */
export async function migrateChannels(storage: Storage = globalThis.localStorage): Promise<void> {
  if (!isTauri()) {
    if (!(await channelRepository.runtime())) {
      await withStorageWrite(storage, () =>
        channelRepository.migrate(
          storage.getItem(CHANNELS_STORAGE_KEY),
          storage.getItem(CHANNEL_INBOX_STORAGE_KEY),
        ),
      );
    }
    return;
  }
  await withStorageWrite(storage, async () => {
    const source = await channelRepository.migrationSource();
    if (!source.migrated) {
      const configRaw = source.configRaw ?? storage.getItem(CHANNELS_STORAGE_KEY);
      // Validate all legacy input before moving secrets or committing anything.
      loadChannelsConfig({ getItem: () => configRaw } as unknown as Storage);
      loadChannelInbox(storage);
      const legacy = configRaw ? (JSON.parse(configRaw) as Partial<ChannelsConfig>) : {};
      const secrets = { ...((await loadProviderSecrets(channelSecretId)) ?? {}) };
      let found = false;
      for (const [key, value] of Object.entries({
        telegramToken: legacy.telegram?.botToken,
        discordWebhook: legacy.discord?.webhookUrl,
        discordToken: legacy.discord?.botToken,
      })) {
        if (typeof value === 'string' && value) {
          secrets[key] ??= value;
          found = true;
        }
      }
      if (found && !(await saveProviderSecrets(channelSecretId, secrets))) {
        throw new Error(
          'Channel credential migration requires durable OS credential storage. Legacy values were retained.',
        );
      }
      await channelRepository.migrate(configRaw, storage.getItem(CHANNEL_INBOX_STORAGE_KEY));
    }
    storage.removeItem(CHANNELS_STORAGE_KEY);
    storage.removeItem(CHANNEL_INBOX_STORAGE_KEY);
  });
}

export async function loadDurableChannelInbox(): Promise<IncomingChannelMessage[]> {
  await migrateChannels();
  return channelRepository.inbox();
}

export function allowedTelegramUpdates(
  messages: IncomingChannelMessage[],
  allowedChatIds: string[],
): IncomingChannelMessage[] {
  const allowed = new Set(allowedChatIds);
  return messages.filter((message) => allowed.has(message.chatId));
}

/**
 * Telegram rejects a message whose text is not valid HTML when `parse_mode` is `HTML`. The text IRIS
 * sends is plain text (approval descriptions contain model- and command-derived values), so a single
 * `<`, `>` or `&` would otherwise make every acknowledgement fail with a 400.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegramMessage(params: {
  botToken: string;
  chatId: string;
  text: string;
  replyMarkup?: Record<string, unknown>;
}): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const { botToken, chatId, text, replyMarkup } = params;
  if (!botToken || !chatId) {
    return { ok: false, error: 'Missing Telegram token or chatId' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: escapeTelegramHtml(text),
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    if (!data.ok) {
      return { ok: false, error: data.description || 'Telegram API returned false' };
    }
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function sendDiscordWebhookMessage(params: {
  webhookUrl: string;
  content: string;
  username?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { webhookUrl, content, username = 'IRIS Operating Environment' } = params;
  if (!webhookUrl) {
    return { ok: false, error: 'Missing Discord webhook URL' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        username,
        avatar_url: 'https://raw.githubusercontent.com/bubbadk/IRIS/main/docs/assets/iris-icon.png',
      }),
    });
    return { ok: res.ok || res.status === 204 };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type TelegramBatch = {
  ok: boolean;
  updates: IncomingChannelMessage[];
  /** Advisory only: the durable runner checkpoints each effect separately. */
  nextOffset: number;
  blocked?: boolean;
};

export async function pollTelegramUpdates(botToken: string, offset = 0): Promise<TelegramBatch> {
  const failed: TelegramBatch = { ok: false, updates: [], nextOffset: offset };
  if (!botToken || !validOffset(offset)) return failed;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=5`,
    );
    if (!res.ok) return failed;
    const data: unknown = await res.json();
    if (!isPlainRecord(data) || data.ok !== true || !Array.isArray(data.result)) return failed;
    const result: TelegramBatch = { ok: true, updates: [], nextOffset: offset };
    // Reject an unidentifiable or unordered batch before consuming any prefix: a later
    // unknown/lower id could otherwise be acknowledged by an earlier higher checkpoint.
    let previous = -1;
    for (const update of data.result) {
      if (
        !isPlainRecord(update) ||
        !validOffset(update.update_id) ||
        update.update_id === Number.MAX_SAFE_INTEGER ||
        update.update_id < previous
      ) {
        return { ...failed, blocked: true };
      }
      previous = update.update_id;
    }
    const seen = new Set<number>();
    for (const raw of data.result) {
      const update = raw as Record<string, unknown> & { update_id: number };
      if (update.update_id < offset || seen.has(update.update_id)) continue;
      seen.add(update.update_id);
      const msg = update.message;
      if (
        !isPlainRecord(msg) ||
        !isPlainRecord(msg.chat) ||
        !(
          (typeof msg.chat.id === 'string' && msg.chat.id.length) ||
          (typeof msg.chat.id === 'number' && Number.isSafeInteger(msg.chat.id))
        ) ||
        typeof msg.text !== 'string' ||
        !validOffset(msg.date) ||
        !Number.isFinite(new Date(msg.date * 1000).getTime()) ||
        (msg.from !== undefined &&
          (!isPlainRecord(msg.from) ||
            ['username', 'first_name'].some(
              (key) =>
                msg.from &&
                isPlainRecord(msg.from) &&
                msg.from[key] !== undefined &&
                typeof msg.from[key] !== 'string',
            )))
      ) {
        result.blocked = true;
        break; // Unsupported events are NOT silently acknowledged.
      }
      const from = isPlainRecord(msg.from) ? msg.from : {};
      result.updates.push({
        id: `tg-${update.update_id}`,
        platform: 'telegram',
        chatId: String(msg.chat.id),
        senderName: String(from.username || from.first_name || 'User'),
        text: msg.text,
        timestamp: new Date(msg.date * 1000).toISOString(),
      });
      result.nextOffset = update.update_id + 1;
    }
    return result;
  } catch {
    return failed;
  }
}

export type ChannelPollOutcome =
  | { status: 'completed' | 'skipped' | 'failed' | 'blocked'; error?: string }
  | { status: 'uncertain'; updateId: number; error: string };

/** Who owns a durable channel claim: this JS runtime, and the OS process it lives in. */
export type ChannelClaimOwner = {
  /** Random per-runtime nonce. Two webviews can share one OS process, so the runtime is the unit. */
  token: string;
  /** The owning OS process when the host can report one, else null. */
  pid: number | null;
};

/** Process liveness is a tri-state verdict; `unknown` is never treated as `dead`. */
export type ChannelProcessLiveness = 'alive' | 'dead' | 'unknown';

type ChannelClaimIdentity = ChannelClaimOwner & {
  isAlive(pid: number): Promise<ChannelProcessLiveness>;
};

function createRuntimeToken(): string {
  const random = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.();
  return random ?? `runner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let claimIdentityReady: Promise<ChannelClaimIdentity> | undefined;

/**
 * This runtime's claim identity, resolved once per JS runtime.
 *
 * Liveness is probed at the OS-process level because that is what the host can answer truthfully
 * (`process_is_alive` is a tri-state verdict, never a boolean). A same-process second webview is
 * therefore reported `alive`, which is correct: the heartbeat lease — not the pid — decides whether
 * that claim is still being maintained. Outside the native runtime the probe answers `unknown` and
 * the lease alone governs recovery, which fails closed on replay.
 */
export function channelClaimIdentity(): Promise<ChannelClaimIdentity> {
  claimIdentityReady ??= (async () => {
    const token = createRuntimeToken();
    if (!isTauri()) return { token, pid: null, isAlive: async () => 'unknown' as const };
    try {
      const pid = await invoke<unknown>('process_own_pid');
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
        return { token, pid: null, isAlive: async () => 'unknown' as const };
      return {
        token,
        pid,
        isAlive: async (target: number): Promise<ChannelProcessLiveness> => {
          try {
            const verdict = (await invoke<unknown>('process_is_alive', { pid: target })) as {
              status?: unknown;
            };
            return verdict?.status === 'alive' || verdict?.status === 'dead'
              ? verdict.status
              : 'unknown';
          } catch {
            return 'unknown';
          }
        },
      };
    } catch {
      return { token, pid: null, isAlive: async () => 'unknown' as const };
    }
  })();
  // Never leave a dangling rejection: an unresolved identity keeps the lease-only behaviour.
  claimIdentityReady.catch(() => undefined);
  return claimIdentityReady;
}

/**
 * Keeps a live claim valid while a long effect runs. The disposer is always called, so the timer is
 * a reversible side effect of the attempt and can never outlive it.
 */
function startClaimHeartbeat(updateId: number, owner: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      if (stopped) return;
      // Best effort: a failed renewal lets the lease lapse, and the lease is the recovery backstop.
      await channelRepository.renewClaim(updateId, owner).catch(() => undefined);
      if (!stopped) schedule();
    }, CHANNEL_CLAIM_HEARTBEAT_MS);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Fixed, secret-free classification text. Raw handler output is never persisted or displayed. */
function attentionEntry(
  updateId: number,
  outcome: ChannelUpdateAttention['outcome'],
  attempts: number,
): ChannelUpdateAttention {
  const reason =
    outcome === 'unknown'
      ? 'The effect outcome could not be determined, so it was not replayed automatically.'
      : outcome === 'poison'
        ? 'The effect never started and its bounded replay budget was exhausted.'
        : 'The effect completed, but its acknowledgement was not confirmed. Automatic resend is refused.';
  return { updateId, outcome, attempts, reason, at: Date.now() };
}

type EffectAttempt =
  | { kind: 'completed' }
  | { kind: 'attention'; entry: ChannelUpdateAttention }
  | { kind: 'retry'; attempts: number; terminal: ChannelUpdateAttention | null }
  /** Another runtime took the claim over; this runtime must not touch the effect or its record. */
  | { kind: 'lost' };

/**
 * Runs one semantic channel effect under the durable write-ahead claim.
 *
 * A generic throw is classified as an unknown outcome, which is the only truthful reading of an
 * opaque failure: the effect may or may not have run, so it is never replayed automatically. A
 * handler that can prove more declares it explicitly through the typed errors above.
 */
async function runChannelEffect(
  updateId: number,
  message: IncomingChannelMessage,
  handler: (message: IncomingChannelMessage) => Promise<void>,
  owner: string,
): Promise<EffectAttempt> {
  // Durable effect-start marker: after this commit a restart can no longer assume the effect absent,
  // and a runtime whose claim was taken over observes the fence here and never starts the effect.
  const pending = await channelRepository.markEffectStarted(updateId, owner);
  if (!pending) return { kind: 'lost' };
  const attempts = pending.updateId === updateId ? pending.attempts : 1;
  const stopHeartbeat = startClaimHeartbeat(updateId, owner);
  try {
    await handler(message);
  } catch (error) {
    if (error instanceof ChannelEffectRetryableError) {
      if (attempts >= CHANNEL_EFFECT_MAX_ATTEMPTS)
        return { kind: 'retry', attempts, terminal: attentionEntry(updateId, 'poison', attempts) };
      return { kind: 'retry', attempts, terminal: null };
    }
    return {
      kind: 'attention',
      entry: attentionEntry(
        updateId,
        error instanceof ChannelEffectCompletedError ? 'completed-with-warning' : 'unknown',
        attempts,
      ),
    };
  } finally {
    stopHeartbeat();
  }
  await channelRepository.complete(updateId, owner);
  return { kind: 'completed' };
}

type AppliedEffect = 'completed' | 'retry-waiting' | 'attention' | 'lost';

/** Applies an attempt's outcome to durable state. Returns `retry-waiting` only for a bounded replay. */
async function applyEffectOutcome(
  updateId: number,
  message: IncomingChannelMessage,
  handler: (message: IncomingChannelMessage) => Promise<void>,
  owner: string,
): Promise<AppliedEffect> {
  const attempt = await runChannelEffect(updateId, message, handler, owner);
  if (attempt.kind === 'completed') return 'completed';
  if (attempt.kind === 'lost') return 'lost';
  if (attempt.kind === 'retry') {
    if (attempt.terminal) {
      await channelRepository.finalize(updateId, owner, attempt.terminal);
      return 'attention';
    }
    await channelRepository.scheduleRetry(updateId, attempt.attempts + 1, owner);
    return 'retry-waiting';
  }
  await channelRepository.finalize(updateId, owner, attempt.entry);
  return 'attention';
}

type PendingRecovery = { status: 'resolved' } | { status: 'waiting' };

/**
 * Decides whether a foreign claim has been abandoned. A positively dead OS process releases the
 * claim at once; anything else — including an `alive` process whose runtime stopped heartbeating,
 * and an `unknown` verdict — is bounded by the lease. `unknown` therefore never permits a takeover
 * while the claim is still fresh, and it never permits a replay of a claim that may have run.
 */
async function foreignClaimAbandoned(
  identity: ChannelClaimIdentity,
  pending: ChannelPendingUpdate,
): Promise<boolean> {
  if (Date.now() - pending.ownerAt >= CHANNEL_CLAIM_LEASE_MS) return true;
  if (pending.ownerPid === null) return false;
  return (await identity.isAlive(pending.ownerPid)) === 'dead';
}

/**
 * Deterministic restart reconciliation of a durable claim. Every branch is decided from committed
 * state alone; no process-local memory is consulted, because there is none after a restart.
 */
async function recoverPendingUpdate(
  identity: ChannelClaimIdentity,
  handler: (message: IncomingChannelMessage) => Promise<void>,
): Promise<PendingRecovery> {
  const seen = await channelRepository.pendingClaim();
  if (!seen) return { status: 'resolved' };
  let pending = seen;
  if (pending.owner !== identity.token) {
    // Another runtime holds this claim. Respect it until its durable lease or its process says it
    // is gone; a live owner keeps the pre-existing single-writer guarantee.
    if (!(await foreignClaimAbandoned(identity, seen))) {
      // Re-read: the owner may have completed while the liveness probe was in flight.
      const current = await channelRepository.pendingClaim();
      return current && current.updateId === seen.updateId && current.owner !== identity.token
        ? { status: 'waiting' }
        : { status: 'resolved' };
    }
    // Atomic takeover. A concurrent renewal or completion makes this commit lose, and the next poll
    // re-evaluates instead of acting on a stale decision.
    const taken = await channelRepository.takeover(
      seen.updateId,
      { owner: seen.owner, ownerAt: seen.ownerAt },
      identity,
    );
    if (!taken) return { status: 'waiting' };
    pending = taken;
  }
  const updateId = pending.updateId;
  // A filtered update carried no semantic effect: nothing to replay, nothing to report.
  if (!pending.effect) {
    await channelRepository.complete(updateId, identity.token);
    return { status: 'resolved' };
  }
  // The effect may already have run. Replaying it could duplicate a non-idempotent action, so the
  // truth is recorded and transport continues instead of latching the whole channel.
  if (pending.replay === 'unsafe') {
    await channelRepository.finalize(
      updateId,
      identity.token,
      attentionEntry(updateId, 'unknown', pending.attempts),
    );
    return { status: 'resolved' };
  }
  // `attempts` is the number the next execution will use, so the budget is spent only once it
  // exceeds the maximum: every allowed attempt is actually run before poison is recorded.
  if (pending.attempts > CHANNEL_EFFECT_MAX_ATTEMPTS) {
    await channelRepository.finalize(
      updateId,
      identity.token,
      attentionEntry(updateId, 'poison', pending.attempts),
    );
    return { status: 'resolved' };
  }
  if (Date.now() - pending.attemptedAt < CHANNEL_EFFECT_RETRY_BACKOFF_MS) return { status: 'waiting' };
  const message = (await channelRepository.inbox()).find((entry) => entry.id === `tg-${updateId}`);
  if (!message) {
    // Without the original message the effect cannot be replayed; record the truth and move on.
    await channelRepository.finalize(
      updateId,
      identity.token,
      attentionEntry(updateId, 'unknown', pending.attempts),
    );
    return { status: 'resolved' };
  }
  return (await applyEffectOutcome(updateId, message, handler, identity.token)) === 'retry-waiting'
    ? { status: 'waiting' }
    : { status: 'resolved' };
}

function describeAttention(entries: ChannelUpdateAttention[]): string {
  return entries
    .map((entry) => `Channel update ${entry.updateId} needs attention: ${entry.reason}`)
    .join(' ');
}

/** Durable needs-attention truth for a channel status surface. Never includes message content. */
export async function loadChannelAttention(): Promise<ChannelUpdateAttention[]> {
  await migrateChannels();
  return (await channelRepository.runtime())?.attention ?? [];
}

// Module scope survives React effect cleanup/recreation and multiple channel windows.
// Cross-webview semantic exclusion is supplied by the durable CAS claim, not this guard.
const activePolls = new Set<string>();
export async function pollChannelOnce(options: {
  config: ChannelsConfig;
  handle: (message: IncomingChannelMessage) => Promise<void>;
  isActive?: () => boolean;
}): Promise<ChannelPollOutcome> {
  const channel = 'telegram';
  if (activePolls.has(channel)) return { status: 'skipped' };
  activePolls.add(channel);
  let resolving: number | undefined;
  try {
    const identity = await channelClaimIdentity();
    await migrateChannels();
    let runtime = await channelRepository.runtime();
    if (!runtime) throw new Error('Channel repository is unavailable.');

    // Durable recovery runs before transport. A claim left by this or a previous process is
    // classified truthfully here instead of latching every later update behind it.
    if (runtime.pending) {
      const recovery = await recoverPendingUpdate(identity, options.handle);
      if (recovery.status === 'waiting')
        return {
          status: 'uncertain',
          updateId: runtime.pending.updateId,
          error:
            runtime.pending.owner === identity.token
              ? 'A channel effect is inside its bounded replay window; recovery continues.'
              : 'Another IRIS runtime owns an unresolved channel update; this runtime defers to it.',
        };
      runtime = await channelRepository.runtime();
      if (!runtime) throw new Error('Channel repository is unavailable.');
      if (runtime.pending)
        return {
          status: 'uncertain',
          updateId: runtime.pending.updateId,
          error: 'A channel effect claim is still unresolved; it is reconciled on the next poll.',
        };
    }

    const result = await pollTelegramUpdates(
      options.config.telegram.botToken,
      runtime.lastUpdateId,
    );
    if (!result.ok) return { status: result.blocked ? 'blocked' : 'failed' };
    const attention: ChannelUpdateAttention[] = [];
    for (const message of result.updates) {
      if (options.isActive && !options.isActive()) return { status: 'skipped' };
      const updateId = Number(message.id.slice(3));
      const accepted = options.config.telegram.allowedChatIds.includes(message.chatId);
      if (
        !(await channelRepository.claim(updateId, accepted ? message : undefined, identity))
      ) {
        const current = await channelRepository.runtime();
        if (current?.pending)
          return {
            status: 'uncertain',
            updateId: current.pending.updateId,
            error: 'Another poll owns an update with an uncertain outcome.',
          };
        continue;
      }
      resolving = updateId;
      if (!accepted) {
        await channelRepository.complete(updateId, identity.token);
        resolving = undefined;
        continue;
      }
      const outcome = await applyEffectOutcome(updateId, message, options.handle, identity.token);
      resolving = undefined;
      if (outcome === 'retry-waiting')
        return {
          status: 'uncertain',
          updateId,
          error: 'The channel effect did not start; a bounded automatic replay is scheduled.',
        };
      if (outcome === 'lost')
        return {
          status: 'uncertain',
          updateId,
          error: 'Another IRIS runtime assumed this channel update; it is reconciled on the next poll.',
        };
      if (outcome === 'attention') {
        const current = await channelRepository.runtime();
        const entry = current?.attention?.find((record) => record.updateId === updateId);
        if (entry) attention.push(entry);
      }
    }
    if (attention.length) return { status: 'completed', error: describeAttention(attention) };
    return { status: result.blocked ? 'blocked' : 'completed' };
  } catch {
    // Neither thrown API payloads nor tokens belong in persisted diagnostics or UI.
    if (resolving !== undefined)
      return {
        status: 'uncertain',
        updateId: resolving,
        error:
          'Channel effect or checkpoint failed. The durable claim is preserved and reconciled on the next poll.',
      };
    return {
      status: 'failed',
      error: 'Channel polling failed before a semantic effect was started.',
    };
  } finally {
    activePolls.delete(channel);
  }
}
