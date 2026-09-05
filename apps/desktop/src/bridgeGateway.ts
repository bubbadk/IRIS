import { loadProviderSecrets, saveProviderSecrets } from './credentials';
import { withStorageWrite } from './storageWrites';

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

export function loadChannelsConfig(storage: Storage = globalThis.localStorage): ChannelsConfig {
  try {
    const raw = storage?.getItem(CHANNELS_STORAGE_KEY);
    if (!raw) return structuredClone(defaultChannelsConfig);
    const parsed = JSON.parse(raw);
    return {
      telegram: { ...defaultChannelsConfig.telegram, ...(parsed.telegram || {}), botToken: '' },
      discord: { ...defaultChannelsConfig.discord, ...(parsed.discord || {}), webhookUrl: '', botToken: '' },
    };
  } catch {
    return structuredClone(defaultChannelsConfig);
  }
}

export function saveChannelsConfig(
  config: ChannelsConfig,
  storage: Storage = globalThis.localStorage,
): void {
  storage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify({
    telegram: { enabled: config.telegram.enabled, allowedChatIds: config.telegram.allowedChatIds, lastUpdateId: config.telegram.lastUpdateId },
    discord: { enabled: config.discord.enabled, channelId: config.discord.channelId },
  }));
}

const channelSecretId = 'iris-channels-connection';

export async function loadChannelConnection(storage: Storage = globalThis.localStorage): Promise<ChannelsConfig> {
  return withStorageWrite(storage, async () => {
    const config = loadChannelsConfig(storage);
    const raw = storage.getItem(CHANNELS_STORAGE_KEY);
    const legacy = raw ? JSON.parse(raw) as Partial<ChannelsConfig> : {};
    const stored = await loadProviderSecrets(channelSecretId) ?? {};
    const oldSecrets = {
      telegramToken: legacy.telegram?.botToken,
      discordWebhook: legacy.discord?.webhookUrl,
      discordToken: legacy.discord?.botToken,
    };
    const secrets = { ...stored };
    let migrating = false;
    for (const [key, value] of Object.entries(oldSecrets)) {
      if (typeof value === 'string' && value) { secrets[key] ??= value; migrating = true; }
    }
    if (migrating) {
      const durable = await saveProviderSecrets(channelSecretId, secrets);
      if (!durable) throw new Error('Open the native desktop app to migrate existing channel credentials into the OS credential store. The original values have been preserved.');
      saveChannelsConfig(config, storage);
    }
    return {
      telegram: { ...config.telegram, botToken: secrets.telegramToken ?? '' },
      discord: { ...config.discord, webhookUrl: secrets.discordWebhook ?? '', botToken: secrets.discordToken ?? '' },
    };
  });
}

export async function saveChannelConnection(config: ChannelsConfig, storage: Storage = globalThis.localStorage): Promise<boolean> {
  return withStorageWrite(storage, async () => {
    const durable = await saveProviderSecrets(channelSecretId, {
      telegramToken: config.telegram.botToken,
      discordWebhook: config.discord.webhookUrl,
      discordToken: config.discord.botToken ?? '',
    });
    saveChannelsConfig(config, storage);
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
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
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

export async function pollTelegramUpdates(
  botToken: string,
  offset: number = 0,
): Promise<{ ok: boolean; updates: IncomingChannelMessage[]; nextOffset: number }> {
  if (!botToken) return { ok: false, updates: [], nextOffset: offset };

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=5`,
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          message_id: number;
          chat: { id: number | string };
          from?: { first_name?: string; username?: string };
          text?: string;
          date: number;
        };
      }>;
    };

    if (!data.ok || !Array.isArray(data.result)) {
      return { ok: false, updates: [], nextOffset: offset };
    }

    let nextOffset = offset;
    const updates: IncomingChannelMessage[] = [];

    for (const update of data.result) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      if (update.message && update.message.text) {
        updates.push({
          id: `tg-${update.update_id}`,
          platform: 'telegram',
          chatId: String(update.message.chat.id),
          senderName: update.message.from?.username || update.message.from?.first_name || 'User',
          text: update.message.text,
          timestamp: new Date(update.message.date * 1000).toISOString(),
        });
      }
    }

    return { ok: true, updates, nextOffset };
  } catch {
    return { ok: false, updates: [], nextOffset: offset };
  }
}
