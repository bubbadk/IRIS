import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadChannelsConfig,
  saveChannelsConfig,
  loadChannelConnection,
  saveChannelConnection,
  sendTelegramMessage,
  sendDiscordWebhookMessage,
  pollTelegramUpdates,
  type ChannelsConfig,
} from './bridgeGateway';

const { loadSecrets, saveSecrets } = vi.hoisted(() => ({ loadSecrets: vi.fn(), saveSecrets: vi.fn() }));
vi.mock('./credentials', () => ({ loadProviderSecrets: loadSecrets, saveProviderSecrets: saveSecrets }));

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    length: values.size,
  };
}

describe('bridgeGateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loadSecrets.mockReset().mockResolvedValue(null);
    saveSecrets.mockReset().mockResolvedValue(true);
  });

  it('loads default config when empty', () => {
    const storage = memoryStorage();
    const config = loadChannelsConfig(storage);
    expect(config.telegram.enabled).toBe(false);
    expect(config.discord.enabled).toBe(false);
  });

  it('persists and reloads updated channel config', () => {
    const storage = memoryStorage();
    const customConfig: ChannelsConfig = {
      telegram: {
        enabled: true,
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        allowedChatIds: ['987654321'],
        lastUpdateId: 10,
      },
      discord: {
        enabled: true,
        webhookUrl: 'https://discord.com/api/webhooks/1234/abcd',
      },
    };

    saveChannelsConfig(customConfig, storage);
    const loaded = loadChannelsConfig(storage);
    expect(loaded.telegram.enabled).toBe(true);
    expect(loaded.telegram.botToken).toBe('');
    expect(loaded.discord.enabled).toBe(true);
    expect(loaded.discord.webhookUrl).toBe('');
  });

  it('sendTelegramMessage validates parameters and calls api', async () => {
    const badRes = await sendTelegramMessage({
      botToken: '',
      chatId: '',
      text: 'hello',
    });
    expect(badRes.ok).toBe(false);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    } as Response);

    const goodRes = await sendTelegramMessage({
      botToken: 'fake-token',
      chatId: '123',
      text: 'Hello from IRIS',
    });
    expect(goodRes.ok).toBe(true);
    expect(goodRes.messageId).toBe(42);
  });

  it('sendDiscordWebhookMessage sends POST request to webhook', async () => {
    const badRes = await sendDiscordWebhookMessage({
      webhookUrl: '',
      content: 'test',
    });
    expect(badRes.ok).toBe(false);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response);

    const goodRes = await sendDiscordWebhookMessage({
      webhookUrl: 'https://discord.com/api/webhooks/test',
      content: 'Test notification',
    });
    expect(goodRes.ok).toBe(true);
  });

  it('pollTelegramUpdates transforms incoming messages into standard shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 101,
            message: {
              message_id: 1,
              chat: { id: 12345 },
              from: { username: 'alice' },
              text: 'run status check',
              date: 1714500000,
            },
          },
        ],
      }),
    } as Response);

    const result = await pollTelegramUpdates('fake-token', 100);
    expect(result.ok).toBe(true);
    expect(result.nextOffset).toBe(102);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].senderName).toBe('alice');
    expect(result.updates[0].text).toBe('run status check');
    expect(result.updates[0].chatId).toBe('12345');
  });
});


it('migrates legacy credentials only after verified durable storage', async () => {
  const storage = memoryStorage();
  const raw = JSON.stringify({ telegram: { botToken: 'legacy-token' }, discord: { webhookUrl: 'legacy-webhook' } });
  storage.setItem('iris.channels.config.v1', raw);
  loadSecrets.mockResolvedValue(null);
  saveSecrets.mockRejectedValueOnce(new Error('Keyring unavailable'));
  await expect(loadChannelConnection(storage)).rejects.toThrow('Keyring unavailable');
  expect(storage.getItem('iris.channels.config.v1')).toBe(raw);
  saveSecrets.mockResolvedValue(true);
  const migrated = await loadChannelConnection(storage);
  expect(migrated.telegram.botToken).toBe('legacy-token');
  expect(storage.getItem('iris.channels.config.v1')).not.toContain('legacy-token');
  expect(storage.getItem('iris.channels.config.v1')).not.toContain('legacy-webhook');
});

it('never persists credentials in channel metadata', async () => {
  const storage = memoryStorage();
  const config = loadChannelsConfig(storage);
  config.telegram.botToken = 'secret-telegram';
  config.discord.webhookUrl = 'secret-discord';
  saveSecrets.mockResolvedValue(true);
  await saveChannelConnection(config, storage);
  expect(storage.getItem('iris.channels.config.v1')).not.toContain('secret-');
});
