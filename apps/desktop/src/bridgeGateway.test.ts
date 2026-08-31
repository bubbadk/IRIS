import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadChannelsConfig,
  saveChannelsConfig,
  sendTelegramMessage,
  sendDiscordWebhookMessage,
  pollTelegramUpdates,
  type ChannelsConfig,
} from './bridgeGateway';

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
    expect(loaded.telegram.botToken).toBe(customConfig.telegram.botToken);
    expect(loaded.discord.enabled).toBe(true);
    expect(loaded.discord.webhookUrl).toBe(customConfig.discord.webhookUrl);
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
