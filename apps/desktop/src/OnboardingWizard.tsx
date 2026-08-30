import { useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import { saveProviderConfigs, loadProviderConfigs, type ProviderConfig } from '@iris/providers';
import { agentRepository, workspaceRepository } from './persistence';
import { mountWorkspace } from './workspace';

export const ONBOARDING_COMPLETED_KEY = 'iris.onboarding.completed.v1';

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
      localStorage.getItem('iris.providers.v1') ||
      localStorage.getItem('iris.providers.config.v2');
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

  const handleComplete = async () => {
    setIsSaving(true);
    setStatusMessage('Configuring your IRIS operating environment…');
    try {
      // 1. Save Provider
      const providerId = `${providerType}-${crypto.randomUUID().slice(0, 8)}`;
      let providerConfig: ProviderConfig;

      if (providerType === 'ollama') {
        providerConfig = {
          id: providerId,
          name: 'Local Ollama',
          kind: 'ollama',
          endpoint: ollamaUrl.trim() || 'http://localhost:11434',
          model: ollamaModel.trim() || 'llama3.2',
          enabled: true,
        };
      } else if (providerType === 'openrouter') {
        providerConfig = {
          id: providerId,
          name: 'OpenRouter',
          kind: 'openai-compatible',
          endpoint: 'https://openrouter.ai/api/v1',
          model: 'anthropic/claude-3.7-sonnet',
          connectionValues: { apiKey: apiKey.trim() },
          enabled: true,
          catalogId: 'openrouter',
        };
      } else if (providerType === 'anthropic') {
        providerConfig = {
          id: providerId,
          name: 'Anthropic Claude',
          kind: 'anthropic',
          endpoint: 'https://api.anthropic.com/v1',
          model: 'claude-3-7-sonnet-20250219',
          connectionValues: { apiKey: apiKey.trim() },
          enabled: true,
          catalogId: 'anthropic',
        };
      } else if (providerType === 'openai') {
        providerConfig = {
          id: providerId,
          name: 'OpenAI',
          kind: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          connectionValues: { apiKey: apiKey.trim() },
          enabled: true,
          catalogId: 'openai',
        };
      } else {
        providerConfig = {
          id: providerId,
          name: 'Google Gemini',
          kind: 'gemini',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          model: 'gemini-2.5-flash',
          connectionValues: { apiKey: apiKey.trim() },
          enabled: true,
          catalogId: 'gemini',
        };
      }

      const existingConfigs = loadProviderConfigs();
      saveProviderConfigs([providerConfig, ...existingConfigs]);

      // 2. Mount Workspace if provided
      if (workspacePath.trim()) {
        try {
          await mountWorkspace(workspacePath.trim());
        } catch {
          await workspaceRepository.save({
            version: 1,
            id: `workspace-${crypto.randomUUID().slice(0, 8)}`,
            name: 'Main Project',
            rootPath: workspacePath.trim(),
            connectedAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
          });
        }
      }

      // 3. Ensure Default Agents exist
      const existingAgents = await agentRepository.list();
      if (existingAgents.length === 0) {
        const workspaceTools = [
          'workspace.list',
          'workspace.search',
          'workspace.read',
          'workspace.directory',
          'workspace.write',
          'workspace.patch',
          'workspace.move',
          'workspace.delete',
          'memory.remember',
          'host.inspect',
          'subagent.delegate',
        ];
        const defaultAgents: AgentDefinition[] = [
          {
            id: `agent-iris-${crypto.randomUUID().slice(0, 8)}`,
            name: 'IRIS Coordinator',
            description:
              'Primary intelligent coordinator with spatial integration and sub-agent delegation.',
            persona:
              'You are IRIS (Intelligent Reasoning & Integration System). You are helpful, precise, and delegate to specialized sub-agents and tools effectively.',
            providerPolicyId: providerId,
            model: providerConfig.model,
            autonomy: 'operate',
            skillIds: [],
            toolIds: workspaceTools,
          },
          {
            id: `agent-dev-${crypto.randomUUID().slice(0, 8)}`,
            name: 'Senior Developer',
            description: 'Specialist in code architecture, refactoring, diagnostics, and Git.',
            persona:
              'You are the Senior Developer Specialist in IRIS. You write clean, type-safe, and thoroughly tested code, strictly adhering to architecture rules and verifying patches with diffs.',
            providerPolicyId: providerId,
            model: providerConfig.model,
            autonomy: 'act',
            skillIds: [],
            toolIds: workspaceTools,
          },
          {
            id: `agent-janitor-${crypto.randomUUID().slice(0, 8)}`,
            name: 'System Janitor',
            description: 'Monitors system health, cleans memory, and maintains workspaces.',
            persona:
              'You are the System Janitor in IRIS. Your job is to keep the system healthy, consolidate long-term memories, and maintain workspace hygiene.',
            providerPolicyId: providerId,
            model: providerConfig.model,
            autonomy: 'act',
            skillIds: [],
            toolIds: [
              'janitor.health',
              'janitor.diagnostics',
              'janitor.command',
              'memory.remember',
              'workspace.list',
              'workspace.read',
              'workspace.write',
            ],
          },
        ];

        for (const agent of defaultAgents) {
          await agentRepository.save(agent);
        }
      }

      markOnboardingComplete();
      onFinish();
    } catch (error) {
      setIsSaving(false);
      setStatusMessage(
        `Setup error: ${error instanceof Error ? error.message : String(error)}`,
      );
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
                <input
                  id="workspace-folder"
                  type="text"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="/path/to/project or leave empty"
                />
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
