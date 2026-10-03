import { useEffect, useState } from 'react';
import {
  defaultChannelsConfig,
  loadChannelConnection,
  saveChannelConnection,
  sendTelegramMessage,
  sendDiscordWebhookMessage,
  loadDurableChannelInbox,
  loadChannelAttention,
  type IncomingChannelMessage,
  type ChannelUpdateAttention,
  type ChannelsConfig,
} from './bridgeGateway';
import { channelRuntimeStatus, subscribeChannelRuntime } from './channelRuntime';

export function ChannelsWindow() {
  const [config, setConfig] = useState<ChannelsConfig>(() =>
    structuredClone(defaultChannelsConfig),
  );
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [inbox, setInbox] = useState<IncomingChannelMessage[]>([]);
  /**
   * Durable needs-attention truth (`unknown` / `poison` / `completed-with-warning` records).
   *
   * A dropped update is classified once and retained, so this is not a transient poll result: it is
   * read whenever the window opens — independently of whether polling is configured — and refreshed
   * after every poll. Reading it only from a poll would hide an update that was dropped before a
   * restart, and disabling Telegram would hide it again.
   */
  const [attention, setAttention] = useState<ChannelUpdateAttention[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState(channelRuntimeStatus);

  function handleSave(next: ChannelsConfig) {
    setConfig(next);
  }

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([loadChannelConnection(), loadDurableChannelInbox()])
      .then(([next, messages]) => {
        if (active) {
          setConfig(next);
          setInbox(messages);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active) setTestStatus(String(error));
      });
    // Additive: a failure to read the attention records must not stop the window from opening, and
    // it is reported in its own right rather than silently swallowed.
    void loadChannelAttention()
      .then((records) => {
        if (active) setAttention(records);
      })
      .catch(() => {
        if (active)
          setTestStatus('Channel attention records could not be read. Existing data was retained.');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return subscribeChannelRuntime(setRuntimeStatus);
  }, []);

  async function saveConnection() {
    setSaving(true);
    try {
      const durable = await saveChannelConnection(config);
      setTestStatus(
        durable
          ? 'Connection saved. Credentials are stored in the OS credential store.'
          : 'Settings saved. Credentials remain in this browser session only.',
      );
    } catch (error) {
      setTestStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestTelegram() {
    if (!config.telegram.botToken) {
      setTestStatus('⚠️ Please enter a Telegram Bot Token');
      return;
    }
    const chatId = config.telegram.allowedChatIds[0];
    if (!chatId) {
      setTestStatus('⚠️ Please specify at least one Allowed Chat ID');
      return;
    }

    setIsTesting(true);
    setTestStatus('Sending test ping to Telegram…');
    const res = await sendTelegramMessage({
      botToken: config.telegram.botToken,
      chatId,
      text: 'IRIS test message delivered. IRIS only accepts approve <approval id> or deny <approval id> from this allowed chat when that approval is pending.',
    });
    setIsTesting(false);
    if (res.ok) {
      setTestStatus('✅ Telegram test message sent successfully!');
    } else {
      setTestStatus(`❌ Telegram error: ${res.error}`);
    }
  }

  async function handleTestDiscord() {
    if (!config.discord.webhookUrl) {
      setTestStatus('⚠️ Please enter a Discord Webhook URL');
      return;
    }

    setIsTesting(true);
    setTestStatus('Sending test ping to Discord…');
    const res = await sendDiscordWebhookMessage({
      webhookUrl: config.discord.webhookUrl,
      content: 'IRIS test message delivered. Automatic agent notifications are not connected.',
    });
    setIsTesting(false);
    if (res.ok) {
      setTestStatus('✅ Discord test webhook fired successfully!');
    } else {
      setTestStatus(`❌ Discord error: ${res.error}`);
    }
  }

  return (
    <div className="channels-window-container">
      <div className="channels-hero-bar">
        <div className="channels-hero-icon">🛸</div>
        <div>
          <h3>Messaging Connections</h3>
          <p>
            Telegram accepts approval decisions only from explicitly allowed chats. Project status
            messages are sent only when you enable them for a channel below.
          </p>
          <p role="status" aria-live="polite">
            {runtimeStatus.message}
          </p>
        </div>
      </div>

      {testStatus && (
        <div className="channels-status-banner">
          <span>{testStatus}</span>
          <button
            type="button"
            className="channels-status-dismiss"
            onClick={() => setTestStatus(null)}
          >
            ✕
          </button>
        </div>
      )}

      {attention.length > 0 && (
        <div className="channels-status-banner" role="status">
          <span>
            {attention.length === 1
              ? 'One channel update needs attention: it was not applied, and the record is retained across restarts.'
              : `${attention.length} channel updates need attention: they were not applied, and the records are retained across restarts.`}{' '}
            {attention.map((entry) => `Update ${entry.updateId}: ${entry.reason}`).join(' ')}
          </span>
        </div>
      )}

      <button
        className="soft-button"
        disabled={!loaded || saving}
        onClick={() => void saveConnection()}
      >
        {saving ? 'Saving…' : 'Save connection settings'}
      </button>
      <fieldset
        disabled={!loaded || saving}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <div className="channels-grid">
          {/* Telegram Card */}
          <div className={`channel-card ${config.telegram.enabled ? 'is-enabled' : ''}`}>
            <div className="channel-card-header">
              <div className="channel-card-brand">
                <span className="channel-icon">✈️</span>
                <div>
                  <h4>Telegram Approvals</h4>
                  <p className="channel-subtitle">Allowed-chat approvals and outgoing tests</p>
                </div>
              </div>
              <span className="truth-pill">Approval messages</span>
            </div>

            <div className="channel-card-body">
              <label className="channel-field">
                <input
                  type="checkbox"
                  checked={config.telegram.enabled}
                  onChange={(e) =>
                    handleSave({
                      ...config,
                      telegram: { ...config.telegram, enabled: e.target.checked },
                    })
                  }
                />{' '}
                Receive messages from allowed chats
              </label>
              <label className="channel-field">
                <input
                  type="checkbox"
                  checked={config.telegram.notifyOnProjectUpdates}
                  onChange={(e) =>
                    handleSave({
                      ...config,
                      telegram: { ...config.telegram, notifyOnProjectUpdates: e.target.checked },
                    })
                  }
                />{' '}
                Send project status updates to these allowed chats
              </label>
              <div className="channel-field">
                <label>Bot Token (from @BotFather)</label>
                <div className="channel-input-group">
                  <input
                    type={showTelegramToken ? 'text' : 'password'}
                    placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                    value={config.telegram.botToken}
                    onChange={(e) =>
                      handleSave({
                        ...config,
                        telegram: { ...config.telegram, botToken: e.target.value },
                      })
                    }
                  />
                  <button
                    type="button"
                    className="channel-btn-ghost"
                    onClick={() => setShowTelegramToken(!showTelegramToken)}
                  >
                    {showTelegramToken ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              <div className="channel-field">
                <label>Allowed Chat IDs (comma-separated for security)</label>
                <input
                  type="text"
                  placeholder="e.g. 123456789"
                  value={config.telegram.allowedChatIds.join(', ')}
                  onChange={(e) =>
                    handleSave({
                      ...config,
                      telegram: {
                        ...config.telegram,
                        allowedChatIds: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </div>

              <div className="channel-card-actions">
                <button
                  type="button"
                  className="channel-btn-primary"
                  disabled={isTesting || !config.telegram.botToken}
                  onClick={handleTestTelegram}
                >
                  📡 Test Connection
                </button>
              </div>
            </div>
          </div>

          {/* Discord Card */}
          <div className={`channel-card ${config.discord.enabled ? 'is-enabled' : ''}`}>
            <div className="channel-card-header">
              <div className="channel-card-brand">
                <span className="channel-icon">🎮</span>
                <div>
                  <h4>Discord Webhook</h4>
                  <p className="channel-subtitle">Test messages and optional project updates</p>
                </div>
              </div>
              <span className="truth-pill">Outgoing messages</span>
            </div>

            <div className="channel-card-body">
              <label className="channel-field">
                <input
                  type="checkbox"
                  checked={config.discord.notifyOnProjectUpdates}
                  onChange={(e) =>
                    handleSave({
                      ...config,
                      discord: { ...config.discord, notifyOnProjectUpdates: e.target.checked },
                    })
                  }
                />{' '}
                Send project status updates to this webhook
              </label>
              <div className="channel-field">
                <label>Discord Webhook URL</label>
                <input
                  type="password"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={config.discord.webhookUrl}
                  onChange={(e) =>
                    handleSave({
                      ...config,
                      discord: { ...config.discord, webhookUrl: e.target.value },
                    })
                  }
                />
              </div>

              <div className="channel-card-actions">
                <button
                  type="button"
                  className="channel-btn-primary"
                  disabled={isTesting || !config.discord.webhookUrl}
                  onClick={handleTestDiscord}
                >
                  📡 Send Discord Test
                </button>
              </div>
            </div>
          </div>
        </div>
      </fieldset>
      <section className="channels-status-banner">
        <strong>Incoming Telegram messages</strong>
        {inbox.length === 0 ? (
          <span>No accepted messages yet.</span>
        ) : (
          inbox.slice(0, 8).map((message) => (
            <p key={message.id}>
              <strong>{message.senderName}</strong>: {message.text}
            </p>
          ))
        )}
      </section>
    </div>
  );
}
