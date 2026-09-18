import { useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import {
  createProviderConfig,
  loadProviderCatalog,
  loadProviderConfigs,
  refreshProviderModels,
  saveProviderConfigs,
  type ProviderCatalogId,
  type ProviderConfig,
} from '@iris/providers';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '@tauri-apps/api/core';
import { agentRepository, permissionRuleRepository } from './persistence';
import { ensureAssignedToolsRequireApproval } from './agentPermissions';
// The lightweight registry identity only: importing './tooling' here would pull the full tool
// initialization (memory service, host inspection) into onboarding and its tests.
import { toolRegistry } from './toolRegistry';
import { mountWorkspace } from './workspace';
import { resolveProviderConnection, saveProviderSecrets } from './credentials';
import { createDefaultAgentTeam, createSystemJanitorPreset } from './agentPresets';

// Re-exported so existing callers and tests keep one import site for the system preset; the
// definition itself lives with the rest of the fresh-install tool identities.
export { createSystemJanitorPreset };

export const ONBOARDING_COMPLETED_KEY = 'iris.onboarding.completed.v1';

type OnboardingProviderType = 'ollama' | 'openrouter' | 'anthropic' | 'openai' | 'gemini';

/**
 * Setup writes the capability-aware catalog default instead of a hardcoded model name (M-27/M-28):
 * the previous literals (`gpt-4o`, `claude-3-7-sonnet-20250219`, `anthropic/claude-3.7-sonnet`, …)
 * were a second, stale model list, and one of them named a model that does not exist. When the
 * catalog is not synced yet the model stays empty and is discovered from the provider itself.
 */
const setupCatalogIds: Record<OnboardingProviderType, ProviderCatalogId> = {
  ollama: 'ollama',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
};

const setupEndpoints: Record<OnboardingProviderType, string> = {
  ollama: 'http://localhost:11434',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

const setupKinds: Record<OnboardingProviderType, ProviderConfig['kind']> = {
  ollama: 'ollama',
  openrouter: 'openai-compatible',
  anthropic: 'anthropic',
  openai: 'openai-compatible',
  gemini: 'gemini',
};

/** Builds the setup configuration from the shared provider catalog, never from a literal list. */
export function setupProviderDefaults(providerType: OnboardingProviderType): ProviderConfig {
  const catalogId = setupCatalogIds[providerType];
  const entry = loadProviderCatalog().find((candidate) => candidate.id === catalogId);
  return entry
    ? createProviderConfig(entry)
    : {
        id: `${catalogId}-${crypto.randomUUID()}`,
        name: providerType,
        kind: setupKinds[providerType],
        endpoint: setupEndpoints[providerType],
        model: '',
        enabled: true,
        catalogId,
      };
}

export function isOnboardingNeeded(): boolean {
  if (localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true') {
    return false;
  }
  // Automatically bypass onboarding for existing users with configured agents or providers
  try {
    const hasAgents =
      localStorage.getItem('iris.agents.v1') ||
      localStorage.getItem('iris.agents.v2') ||
      localStorage.getItem('iris.agents.config.v2');
    const hasProviders =
      localStorage.getItem('iris.providers.v1') || localStorage.getItem('iris.providers.config.v2');
    const hasWindows = localStorage.getItem('iris.desktop.windows.v1');
    const hasMemory = localStorage.getItem('iris.memory.records.v1');
    if (hasAgents || hasProviders || hasWindows || hasMemory) {
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
      return false;
    }
  } catch {
    /* ignore */
  }
  return true;
}

export function markOnboardingComplete(): void {
  localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
}

export function OnboardingWizard({
  onFinish,
  darkMode,
}: {
  onFinish: () => void;
  darkMode: boolean;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [providerType, setProviderType] = useState<
    'ollama' | 'openrouter' | 'anthropic' | 'openai' | 'gemini'
  >('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.2');
  const [workspacePath, setWorkspacePath] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSkip = () => {
    markOnboardingComplete();
    onFinish();
  };

  const handleNextStep1 = () => {
    if (providerType !== 'ollama' && !apiKey.trim()) {
      setStatusMessage('Please enter an API key to continue (or select Local Ollama).');
      return;
    }
    setStatusMessage(null);
    setStep(2);
  };

  const handleNextStep2 = () => {
    setStep(3);
  };

  const chooseWorkspace = async () => {
    if (!isTauri()) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a project workspace',
      });
      if (typeof selected === 'string') {
        setWorkspacePath(selected);
        setStatusMessage(null);
      }
    } catch (error) {
      setStatusMessage(
        `Could not open the folder chooser: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const handleComplete = async () => {
    setIsSaving(true);
    setStatusMessage('Configuring your IRIS operating environment…');
    try {
      // 1. Prepare the provider. The workspace is verified before any configuration is saved.
      const providerId = `${providerType}-${crypto.randomUUID().slice(0, 8)}`;
      const defaults = setupProviderDefaults(providerType);
      let providerConfig: ProviderConfig =
        providerType === 'ollama'
          ? {
              ...defaults,
              id: providerId,
              name: 'Local Ollama',
              endpoint: ollamaUrl.trim() || setupEndpoints.ollama,
              // The local model name is a user choice made in this form, not a capability guess.
              model: ollamaModel.trim() || defaults.model,
            }
          : {
              ...defaults,
              id: providerId,
              connectionValues: { apiKey: apiKey.trim() },
            };

      // 2. Mount Workspace if provided. Never create an unverified fallback record.
      if (workspacePath.trim()) {
        await mountWorkspace(workspacePath.trim());
      }

      // 3. Store a cloud key before persisting its public configuration. Provider configuration
      // intentionally removes secret fields, so saving it first would leave setup unusable.
      if (providerType !== 'ollama') {
        const storedInOsKeyring = await saveProviderSecrets(providerId, { apiKey: apiKey.trim() });
        providerConfig = {
          ...providerConfig,
          connectionValues: storedInOsKeyring ? undefined : providerConfig.connectionValues,
          ...(storedInOsKeyring ? { storedSecretFields: ['apiKey'] } : {}),
        };
      }

      // 3b. When the shared catalog has no model list yet (it syncs from models.dev on first run of
      // the Models surface), ask the provider for its real models and let the same capability-aware
      // policy pick the default. An offline or failing provider keeps the empty model state instead
      // of a guessed name; nothing is hardcoded and setup still completes.
      if (providerType !== 'ollama' && !providerConfig.model.trim()) {
        try {
          const connected = await resolveProviderConnection(providerConfig);
          const discovered = await refreshProviderModels(connected);
          providerConfig = {
            ...discovered,
            connectionValues: providerConfig.connectionValues,
            storedSecretFields: providerConfig.storedSecretFields,
          };
        } catch {
          /* The Models surface can refresh and choose a default later. */
        }
      }

      const existingConfigs = loadProviderConfigs();
      saveProviderConfigs([providerConfig, ...existingConfigs]);

      // 4. Ensure Default Agents exist
      const existingAgents = await agentRepository.list();
      if (existingAgents.length === 0) {
        const defaultAgents: AgentDefinition[] = createDefaultAgentTeam(
          providerId,
          providerConfig.model,
        );

        for (const agent of defaultAgents) {
          await agentRepository.save(agent);
        }
        await ensureAssignedToolsRequireApproval(
          permissionRuleRepository,
          defaultAgents,
          toolRegistry.list(),
          await permissionRuleRepository.list(),
        );
      }

      markOnboardingComplete();
      onFinish();
    } catch (error) {
      setIsSaving(false);
      setStatusMessage(`Setup error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className={`onboarding-modal-backdrop ${darkMode ? 'dark-mode' : ''}`}>
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="onboarding-header">
          <div className="onboarding-brand-row">
            <div className="onboarding-brand">
              <span className="onboarding-status-dot" />
              <h1 id="onboarding-title" className="onboarding-title">
                Welcome to IRIS
              </h1>
            </div>
            <button
              type="button"
              className="onboarding-skip-top-btn"
              onClick={handleSkip}
              title="Skip setup and open existing workspace"
              aria-label="Skip setup"
            >
              Skip ✕
            </button>
          </div>
          <p className="onboarding-subtitle">
            Intelligent Reasoning & Integration System · Get started in 1 minute
          </p>

          <div className="onboarding-progress-track">
            <div
              className={`progress-step ${step >= 1 ? 'is-active' : ''} ${step > 1 ? 'is-completed' : ''}`}
            >
              <span className="step-num">1</span>
              <span className="step-label">Model Provider</span>
            </div>
            <div className="progress-line" />
            <div
              className={`progress-step ${step >= 2 ? 'is-active' : ''} ${step > 2 ? 'is-completed' : ''}`}
            >
              <span className="step-num">2</span>
              <span className="step-label">Workspace</span>
            </div>
            <div className="progress-line" />
            <div className={`progress-step ${step >= 3 ? 'is-active' : ''}`}>
              <span className="step-num">3</span>
              <span className="step-label">Agent Team</span>
            </div>
          </div>
        </div>

        <div className="onboarding-body">
          {step === 1 && (
            <div className="step-content">
              <h3>Step 1: Choose Your AI Model Provider</h3>
              <p className="step-desc">
                IRIS is 100% model-agnostic. Run completely locally with Ollama or connect leading
                cloud providers.
              </p>

              <div className="provider-selection-grid">
                <button
                  type="button"
                  className={`provider-card ${providerType === 'openrouter' ? 'selected' : ''}`}
                  onClick={() => setProviderType('openrouter')}
                >
                  <span className="provider-icon">🌐</span>
                  <div className="provider-info">
                    <strong>OpenRouter</strong>
                    <span>Claude 3.7, GPT-4o, DeepSeek R1</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`provider-card ${providerType === 'ollama' ? 'selected' : ''}`}
                  onClick={() => setProviderType('ollama')}
                >
                  <span className="provider-icon">🦙</span>
                  <div className="provider-info">
                    <strong>Local Ollama</strong>
                    <span>100% offline, private, and free</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`provider-card ${providerType === 'anthropic' ? 'selected' : ''}`}
                  onClick={() => setProviderType('anthropic')}
                >
                  <span className="provider-icon">⚡</span>
                  <div className="provider-info">
                    <strong>Anthropic Claude</strong>
                    <span>Direct API (Claude 3.7 Sonnet)</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`provider-card ${providerType === 'openai' ? 'selected' : ''}`}
                  onClick={() => setProviderType('openai')}
                >
                  <span className="provider-icon">🧠</span>
                  <div className="provider-info">
                    <strong>OpenAI</strong>
                    <span>Direct API (GPT-4o, o3-mini)</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`provider-card ${providerType === 'gemini' ? 'selected' : ''}`}
                  onClick={() => setProviderType('gemini')}
                >
                  <span className="provider-icon">💎</span>
                  <div className="provider-info">
                    <strong>Google Gemini</strong>
                    <span>Gemini 2.5 Flash / Pro</span>
                  </div>
                </button>
              </div>

              <div className="provider-config-inputs">
                {providerType === 'ollama' ? (
                  <div className="input-group">
                    <label htmlFor="ollama-url">Ollama Server URL:</label>
                    <input
                      id="ollama-url"
                      type="text"
                      value={ollamaUrl}
                      onChange={(e) => setOllamaUrl(e.target.value)}
                      placeholder="http://localhost:11434"
                    />
                    <label htmlFor="ollama-model" style={{ marginTop: 8 }}>
                      Model Name:
                    </label>
                    <input
                      id="ollama-model"
                      type="text"
                      value={ollamaModel}
                      onChange={(e) => setOllamaModel(e.target.value)}
                      placeholder="e.g. llama3.2, qwen2.5-coder"
                    />
                  </div>
                ) : (
                  <div className="input-group">
                    <label htmlFor="provider-api-key">API Key for {providerType}:</label>
                    <input
                      id="provider-api-key"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      autoFocus
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="step-content">
              <h3>Step 2: Mount a Project Workspace (Optional)</h3>
              <p className="step-desc">
                Mount a folder on your computer where agents can read and edit files safely with
                permission gates. You can change this anytime.
              </p>

              <div className="input-group">
                <label htmlFor="workspace-folder">Path to project folder:</label>
                <div className="onboarding-workspace-picker">
                  <input
                    id="workspace-folder"
                    type="text"
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    placeholder="/path/to/project or leave empty"
                  />
                  {isTauri() && (
                    <button
                      type="button"
                      className="onboarding-btn-secondary"
                      onClick={chooseWorkspace}
                    >
                      Choose folder
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="step-content">
              <h3>Step 3: Your Starter Specialist Team</h3>
              <p className="step-desc">
                IRIS automatically configures a starter team of specialists you can customize
                anytime:
              </p>

              <div className="agent-preview-list">
                <div className="agent-preview-card">
                  <span className="agent-avatar">👑</span>
                  <div>
                    <strong>IRIS Coordinator</strong>
                    <p>Primary coordinator with reasoning, MCP tools, and sub-agent delegation.</p>
                  </div>
                </div>
                <div className="agent-preview-card">
                  <span className="agent-avatar">💻</span>
                  <div>
                    <strong>Senior Developer</strong>
                    <p>Code architecture, refactoring, diagnostics, and visual diff reviews.</p>
                  </div>
                </div>
                <div className="agent-preview-card">
                  <span className="agent-avatar">🛡️</span>
                  <div>
                    <strong>System Janitor</strong>
                    <p>Monitors system health, cleans memory, and maintains workspaces.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {statusMessage && <p className="onboarding-status-message">{statusMessage}</p>}
        </div>

        <div className="onboarding-footer">
          {step > 1 && (
            <button
              type="button"
              className="onboarding-btn-secondary"
              onClick={() => setStep((s) => (s - 1) as 1 | 2)}
            >
              ← Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step === 1 && (
            <button type="button" className="onboarding-btn-primary" onClick={handleNextStep1}>
              Next: Workspace →
            </button>
          )}
          {step === 2 && (
            <button type="button" className="onboarding-btn-primary" onClick={handleNextStep2}>
              Next: Agent Team →
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="onboarding-btn-primary finalize"
              onClick={handleComplete}
              disabled={isSaving}
            >
              {isSaving ? 'Configuring…' : '🚀 Launch IRIS'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
