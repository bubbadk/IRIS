import { useState } from 'react';
import {
  loadChannelsConfig,
  saveChannelsConfig,
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
    saveChannelsConfig(next);
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
      text: '🛸 <b>IRIS Messaging Bridge Connected!</b>\nYou can now interact with your IRIS Operating Environment directly from Telegram.',
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
      content: '🛸 **IRIS Messaging Bridge Connected!** Your desktop agent is now linked to this channel.',
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
          <h3>Messaging Channels & Mobile Bridge</h3>
          <p>
            Control IRIS from your phone via Telegram or Discord while the Desklet runs in the
            background.
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

      <div className="channels-grid">
        {/* Telegram Card */}
        <div className={`channel-card ${config.telegram.enabled ? 'is-enabled' : ''}`}>
          <div className="channel-card-header">
            <div className="channel-card-brand">
              <span className="channel-icon">✈️</span>
              <div>
                <h4>Telegram Bot Bridge</h4>
                <p className="channel-subtitle">Direct 2-way mobile chat & tool approvals</p>
              </div>
            </div>
            <label className="channel-toggle-switch">
              <input
                type="checkbox"
                checked={config.telegram.enabled}
                onChange={(e) =>
                  handleSave({
                    ...config,
                    telegram: { ...config.telegram, enabled: e.target.checked },
                  })
                }
              />
              <span className="channel-toggle-slider"></span>
            </label>
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
                <h4>Discord Webhook Bridge</h4>
                <p className="channel-subtitle">Stream agent task updates & notifications</p>
              </div>
            </div>
            <label className="channel-toggle-switch">
              <input
                type="checkbox"
                checked={config.discord.enabled}
                onChange={(e) =>
                  handleSave({
                    ...config,
                    discord: { ...config.discord, enabled: e.target.checked },
                  })
                }
              />
              <span className="channel-toggle-slider"></span>
            </label>
          </div>

          <div className="channel-card-body">
            <div className="channel-field">
              <label>Discord Webhook URL</label>
              <input
                type="text"
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
    </div>
  );
}
