import { useEffect, useState } from 'react';
import {
  loadChannelsConfig,
  loadChannelConnection,
  saveChannelConnection,
  sendTelegramMessage,
  sendDiscordWebhookMessage,
  type ChannelsConfig,
} from './bridgeGateway';

export function ChannelsWindow() {
  const [config, setConfig] = useState<ChannelsConfig>(() => loadChannelsConfig());
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  function handleSave(next: ChannelsConfig) {
    setConfig(next);

  }

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void loadChannelConnection().then((next) => {
      if (active) { setConfig(next); setLoaded(true); }
    }).catch((error: unknown) => { if (active) setTestStatus(String(error)); });
    return () => { active = false; };
  }, []);

  async function saveConnection() {
    setSaving(true);
    try {
      const durable = await saveChannelConnection(config);
      setTestStatus(durable ? 'Connection saved. Credentials are stored in the OS credential store.' : 'Settings saved. Credentials remain in this browser session only.');
    } catch (error) { setTestStatus(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
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
      text: 'IRIS test message delivered. Incoming messages and remote agent control are not connected.',
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
            Configure and send test messages to Telegram or Discord. Incoming messages, remote approvals and automatic agent notifications are not connected.
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

      <button className="soft-button" disabled={!loaded || saving} onClick={() => void saveConnection()}>{saving ? 'Saving…' : 'Save connection settings'}</button>
      <fieldset disabled={!loaded || saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="channels-grid">
        {/* Telegram Card */}
        <div className={`channel-card ${config.telegram.enabled ? 'is-enabled' : ''}`}>
          <div className="channel-card-header">
            <div className="channel-card-brand">
              <span className="channel-icon">✈️</span>
              <div>
                <h4>Telegram Test Connection</h4>
                <p className="channel-subtitle">Outgoing test messages only</p>
              </div>
            </div>
            <span className="truth-pill">Test messages only</span>
          </div>

          <div className="channel-card-body">
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
                <h4>Discord Test Connection</h4>
                <p className="channel-subtitle">Outgoing webhook test messages only</p>
              </div>
            </div>
            <span className="truth-pill">Test messages only</span>
          </div>

          <div className="channel-card-body">
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
    </div>
  );
}
