import { useEffect, useMemo, useState } from 'react';
import type {
  GitHubAuthStatus,
  GitHubIssue,
  GitHubRelease,
  GitHubReleaseAsset,
  GitHubRepo,
  GitHubWorkflow,
  GitHubWorkflowRun,
  NewProjectDraft,
} from '@iris/github';
import { bumpSemVer, generateReleaseNotes, generateProjectScaffolding } from '@iris/github';
import { githubService, persistGitHubToken, clearGitHubToken, initGitHubService } from './githubService';
import { agentRepository, conversationRepository } from './persistence';
import { agentRuntime } from './agentRuntime';
import type { AgentDefinition } from '@iris/core';
import type { ConversationMessage } from '@iris/agents';
import { workspaceService } from './workspace';
import { GitHubIcon } from './icons';

export function GitHubState() {
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus>({ authenticated: false });
  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Repositories
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Active Tab for selected repo
  const [activeTab, setActiveTab] = useState<'agent' | 'releases' | 'workflows'>('agent');

  // Repo details
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [workflows, setWorkflows] = useState<GitHubWorkflow[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<GitHubWorkflowRun[]>([]);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);

  // Agent Chat State
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [composerInput, setComposerInput] = useState('');
  const [agentWorking, setAgentWorking] = useState(false);

  // New Project Walkthrough Wizard State
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [newProject, setNewProject] = useState<NewProjectDraft>({
    name: '',
    description: '',
    website: '',
    topics: [],
    includeReleases: true,
    includeDeployments: true,
    includePackages: true,
    isPrivate: false,
    license: 'MIT',
    template: 'rust-tauri',
    setupActionsWorkflow: true,
  });
  const [topicsInput, setTopicsInput] = useState('');
  const [wizardStatus, setWizardStatus] = useState<'idle' | 'scaffolding' | 'pushing' | 'completed'>('idle');

  // Release Creation Modal State
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [newReleaseTag, setNewReleaseTag] = useState('v0.2.0');
  const [newReleaseTitle, setNewReleaseTitle] = useState('Release v0.2.0');
  const [newReleaseNotes, setNewReleaseNotes] = useState('');

  // Initial load
  useEffect(() => {
    let active = true;
    async function init() {
      setLoading(true);
      await initGitHubService();
      const status = await githubService.validateAuth();
      if (!active) return;
      setAuthStatus(status);
      if (status.authenticated) {
        try {
          const list = await githubService.listRepositories();
          if (active) setRepos(list);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : String(err));
        }
      }
      const loadedAgents = await agentRepository.list();
      if (!active) return;
      setAgents(loadedAgents);
      const ghAgent = loadedAgents.find((a) => a.autonomy === 'github') || loadedAgents[0];
      if (ghAgent) setSelectedAgentId(ghAgent.id);
      setLoading(false);
    }
    init();
    return () => {
      active = false;
    };
  }, []);

  // When repo is selected, fetch details
  useEffect(() => {
    if (!selectedRepo || !authStatus.authenticated) return;
    let active = true;
    async function loadRepoData() {
      if (!selectedRepo) return;
      const owner = selectedRepo.owner.login;
      const repo = selectedRepo.name;
      try {
        const [loadedReleases, loadedWorkflows, loadedRuns, loadedIssues] = await Promise.allSettled([
          githubService.listReleases(owner, repo),
          githubService.listWorkflows(owner, repo),
          githubService.listWorkflowRuns(owner, repo),
          githubService.listIssues(owner, repo, 'open'),
        ]);
        if (!active) return;
        if (loadedReleases.status === 'fulfilled') setReleases(loadedReleases.value);
        if (loadedWorkflows.status === 'fulfilled') setWorkflows(loadedWorkflows.value);
        if (loadedRuns.status === 'fulfilled') setWorkflowRuns(loadedRuns.value);
        if (loadedIssues.status === 'fulfilled') setIssues(loadedIssues.value);

        // Pre-fill next release tag suggestion
        if (loadedReleases.status === 'fulfilled' && loadedReleases.value.length > 0) {
          const latestTag = loadedReleases.value[0]?.tag_name || 'v0.1.0';
          const nextTag = bumpSemVer(latestTag, 'minor');
          setNewReleaseTag(nextTag);
          setNewReleaseTitle(`Release ${nextTag}`);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    }
    loadRepoData();
    return () => {
      active = false;
    };
  }, [selectedRepo, authStatus.authenticated]);

  // Load conversation when selected agent changes
  useEffect(() => {
    if (!selectedAgentId) return;
    let active = true;
    async function loadConv() {
      const conv = await conversationRepository.list(selectedAgentId);
      if (!active) return;
      setMessages(conv || []);
    }
    loadConv();
    return () => {
      active = false;
    };
  }, [selectedAgentId]);

  // Handle Sign In
  async function handleSignIn() {
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError('');
    try {
      await persistGitHubToken(tokenInput.trim());
      const status = await githubService.validateAuth();
      setAuthStatus(status);
      if (status.authenticated) {
        const list = await githubService.listRepositories();
        setRepos(list);
        setTokenInput('');
      } else {
        setError(status.error || 'Authentication failed. Please verify your GitHub Personal Access Token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Handle Sign Out
  async function handleSignOut() {
    setBusy(true);
    try {
      await clearGitHubToken();
      setAuthStatus({ authenticated: false });
      setRepos([]);
      setSelectedRepo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Send message to GitHub agent
  async function handleSendMessage(promptText?: string) {
    const textToSend = promptText || composerInput;
    if (!textToSend.trim() || !selectedAgentId || agentWorking) return;

    setComposerInput('');
    setAgentWorking(true);
    setError('');

    const contextPrefix = selectedRepo
      ? `[Repository: ${selectedRepo.full_name}, Default Branch: ${selectedRepo.default_branch}]\n`
      : '';

    try {
      const fullPrompt = `${contextPrefix}${textToSend}`;
      const events = await agentRuntime.send(selectedAgentId, fullPrompt);

      for await (const event of events) {
        if (event.type === 'assistant-complete') {
          const conv = await conversationRepository.list(selectedAgentId);
          if (conv) setMessages(conv);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgentWorking(false);
      const conv = await conversationRepository.list(selectedAgentId);
      if (conv) setMessages(conv);
    }
  }

  // Handle New Project Creation
  async function handleCreateProject() {
    if (!newProject.name.trim()) {
      setError('Project name is required.');
      return;
    }

    setWizardStatus('scaffolding');
    setError('');

    try {
      const topics = topicsInput
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const draft: NewProjectDraft = {
        ...newProject,
        topics,
      };

      const files = generateProjectScaffolding(draft);

      for (const file of files) {
        try {
          await workspaceService.writeFile(file.path, file.content, true);
        } catch {
          // Best effort if no workspace mounted yet
        }
      }

      setWizardStatus('pushing');
      const createdRepo = await githubService.createRepository(draft);

      setRepos((prev) => [createdRepo, ...prev]);
      setSelectedRepo(createdRepo);
      setWizardStatus('completed');
      setWizardStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWizardStatus('idle');
    }
  }

  // Handle Publish Release
  async function handlePublishRelease() {
    if (!selectedRepo || !newReleaseTag.trim()) return;
    setBusy(true);
    setError('');
    try {
      const owner = selectedRepo.owner.login;
      const repo = selectedRepo.name;

      const fullNotes =
        newReleaseNotes.trim() ||
        generateReleaseNotes(
          newReleaseTag,
          `Automated release of ${selectedRepo.name} with verified production binary builds.`,
          ['iris-linux-x86_64.tar.gz', 'iris.AppImage']
        );

      const created = await githubService.createRelease(owner, repo, {
        tagName: newReleaseTag,
        name: newReleaseTitle || newReleaseTag,
        body: fullNotes,
        draft: false,
        prerelease: false,
      });

      setReleases((prev) => [created, ...prev]);

      if (workflows.length > 0) {
        const releaseWorkflow =
          workflows.find((w) => w.path.includes('release') || w.name.toLowerCase().includes('release')) ||
          workflows[0];
        if (releaseWorkflow) {
          await githubService.triggerWorkflow(owner, repo, releaseWorkflow.id, selectedRepo.default_branch);
        }
      }

      setShowReleaseModal(false);
      setNewReleaseNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Handle Toggle Repository Visibility (Public <-> Private)
  async function handleToggleVisibility() {
    if (!selectedRepo) return;
    const targetPrivacy = !selectedRepo.private;
    const confirmMessage = targetPrivacy
      ? `Are you sure you want to make ${selectedRepo.name} PRIVATE?`
      : `Are you sure you want to make ${selectedRepo.name} PUBLIC?`;
    if (!window.confirm(confirmMessage)) return;

    setBusy(true);
    setError('');
    try {
      const updated = await githubService.updateRepositoryVisibility(
        selectedRepo.owner.login,
        selectedRepo.name,
        targetPrivacy
      );
      setSelectedRepo(updated);
      setRepos((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Handle Toggle Takeover (Switch to expert model on the fly)
  async function handleToggleTakeover() {
    const agent = agents.find((a) => a.id === selectedAgentId);
    if (!agent) return;

    if (!agent.takeoverModel) {
      setError(
        `Agent "${agent.name}" does not have a Takeover Model configured. Open the agent editor to select a Takeover Model under Expert AI.`
      );
      return;
    }

    setBusy(true);
    setError('');
    try {
      const isCurrentlyTakeover = agent.model === agent.takeoverModel;
      const targetModel = agent.takeoverModel;
      const targetProvider = agent.takeoverProviderPolicyId || agent.providerPolicyId;

      const updated: AgentDefinition = {
        ...agent,
        model: targetModel,
        providerPolicyId: targetProvider,
        takeoverModel: agent.model,
        takeoverProviderPolicyId: agent.providerPolicyId,
      };

      await agentRepository.save(updated);
      agentRuntime.refreshConfiguration(updated.id);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));

      if (!isCurrentlyTakeover) {
        await handleSendMessage(
          `⚡ [TAKEOVER ACTIVATED: ${targetModel}] Taking over this turn with expert reasoning capabilities. Reviewing previous context and proceeding with advanced solution.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Filtered repositories
  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.description && r.description.toLowerCase().includes(q))
    );
  }, [repos, repoSearch]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId),
    [agents, selectedAgentId]
  );

  if (loading) {
    return (
      <div className="github-state">
        <div className="github-empty-notice">
          Loading GitHub Operating Environment...
        </div>
      </div>
    );
  }

  return (
    <div className="github-state">
      {/* Top Header & Auth Bar */}
      <header className="github-heading">
        <div>
          <div className="github-heading-title-row">
            <span className="github-heading-icon">
              <GitHubIcon />
            </span>
            <p className="eyebrow">GitHub Operations</p>
          </div>
          <h2>Autonomous Versioning & Releases</h2>
          <p>
            Manage repositories, triage issues with specialist GitHub agents, and ship automated binary releases.
          </p>
        </div>

        <div className="github-auth-bar">
          {authStatus.authenticated && authStatus.user ? (
            <>
              <div className="github-auth-user">
                {authStatus.user.avatar_url && (
                  <img
                    src={authStatus.user.avatar_url}
                    alt={authStatus.user.login}
                    className="github-auth-avatar"
                  />
                )}
                <span>@{authStatus.user.login}</span>
                <span className="status-dot" />
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={busy}
                className="soft-button"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <input
                type="password"
                placeholder="Enter GitHub Personal Access Token..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="github-token-input"
              />
              <button
                type="button"
                onClick={handleSignIn}
                disabled={busy || !tokenInput.trim()}
                className="soft-button primary-button"
              >
                {busy ? 'Connecting…' : 'Connect GitHub'}
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="workspace-error" style={{ margin: 0 }}>
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
            ✕
          </button>
        </div>
      )}

      {/* Main Workspace Browser */}
      <div className="github-browser">
        {/* Left Sidebar: Repositories List */}
        <aside className="github-sidebar">
          <div className="github-sidebar-toolbar">
            <div className="github-sidebar-header">
              <span>Repositories ({repos.length})</span>
              <button
                type="button"
                onClick={() => {
                  setWizardStep(1);
                  setShowWizard(true);
                }}
                className="soft-button primary-button"
                style={{ padding: '3px 8px', fontSize: '10.5px' }}
              >
                ＋ New Project
              </button>
            </div>
            <input
              type="text"
              placeholder="Filter repositories…"
              value={repoSearch}
              onChange={(e) => setRepoSearch(e.target.value)}
              className="github-search-input"
            />
          </div>

          <div className="github-repo-list">
            {filteredRepos.length === 0 ? (
              <div className="github-empty-notice" style={{ margin: '20px 10px', fontSize: '11px' }}>
                {!authStatus.authenticated
                  ? 'Connect your GitHub account above to load repositories.'
                  : 'No repositories found.'}
              </div>
            ) : (
              filteredRepos.map((repo) => {
                const isSelected = selectedRepo?.id === repo.id;
                return (
                  <button
                    type="button"
                    key={repo.id}
                    onClick={() => setSelectedRepo(repo)}
                    className={`github-repo-card ${isSelected ? 'selected' : ''}`}
                  >
                    <div className="github-repo-name-row">
                      <span className="github-repo-name">{repo.name}</span>
                      {repo.private && <span className="github-badge">private</span>}
                    </div>
                    {repo.description && (
                      <p className="github-repo-desc">{repo.description}</p>
                    )}
                    <div className="github-repo-meta">
                      <span>★ {repo.stargazers_count}</span>
                      <span>🌿 {repo.default_branch}</span>
                      {repo.open_issues_count > 0 && <span>⚠️ {repo.open_issues_count}</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Panel: Selected Repo Workspace & Agent Chat */}
        <main className="github-workspace-panel">
          {selectedRepo ? (
            <>
              {/* Panel Header */}
              <div className="github-panel-header">
                <div className="github-panel-title-area">
                  <span className="github-panel-title">{selectedRepo.full_name}</span>
                  <a
                    href={selectedRepo.html_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--muted)', textDecoration: 'none' }}
                    title="Open on GitHub"
                  >
                    ↗
                  </a>
                  <span className="github-badge">🌿 {selectedRepo.default_branch}</span>
                  <button
                    type="button"
                    onClick={handleToggleVisibility}
                    disabled={busy}
                    className="soft-button"
                    style={{ padding: '2px 8px', fontSize: '10.5px' }}
                    title="Toggle repository visibility between public and private"
                  >
                    {selectedRepo.private ? '🔒 Private → Make Public' : '🌐 Public → Make Private'}
                  </button>
                </div>

                <div className="github-tab-nav">
                  <button
                    type="button"
                    onClick={() => setActiveTab('agent')}
                    className={`github-tab-btn ${activeTab === 'agent' ? 'active' : ''}`}
                  >
                    🤖 GitHub Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('releases')}
                    className={`github-tab-btn ${activeTab === 'releases' ? 'active' : ''}`}
                  >
                    🚀 Releases ({releases.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('workflows')}
                    className={`github-tab-btn ${activeTab === 'workflows' ? 'active' : ''}`}
                  >
                    ⚙️ Workflows ({workflows.length})
                  </button>
                </div>
              </div>

              {/* Tab 1: Agent & Autonomous Debugging */}
              {activeTab === 'agent' && (
                <div className="github-agent-container">
                  <div className="github-agent-controls">
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', fontSize: '11px' }}>
                      <span style={{ color: 'var(--muted)', fontWeight: 600 }}>Active Agent:</span>
                      <select
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        style={{ padding: '3px 8px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface)', fontSize: '11px' }}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.autonomy})
                          </option>
                        ))}
                      </select>
                      {currentAgent && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '10px', color: 'var(--muted)' }}>
                            Model: <b>{currentAgent.model || 'standard'}</b>
                          </span>
                          {currentAgent.takeoverModel && (
                            <button
                              type="button"
                              onClick={handleToggleTakeover}
                              disabled={busy || agentWorking}
                              className="soft-button"
                              style={{
                                padding: '2px 8px',
                                fontSize: '10.5px',
                                background: 'rgba(255, 180, 0, 0.15)',
                                borderColor: 'rgba(255, 180, 0, 0.4)',
                                fontWeight: 650,
                                color: 'var(--ink)',
                              }}
                              title={`Switch to Takeover model: ${currentAgent.takeoverModel}`}
                            >
                              ⚡ Takeover ({currentAgent.takeoverModel})
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="github-quick-actions">
                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            `Review open issues for ${selectedRepo.name}, diagnose root causes and propose surgical pull requests.`
                          )
                        }
                        disabled={agentWorking}
                        className="github-quick-action-btn"
                      >
                        🐞 Triage Issues ({issues.length})
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            `Prepare a versioned release: bump SemVer version, generate changelog notes, and trigger the GitHub release workflow for binary builds.`
                          )
                        }
                        disabled={agentWorking}
                        className="github-quick-action-btn"
                      >
                        🚀 Automate Release
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            `Check the status of recent GitHub Actions CI/CD runs and verify if binary artifact builds passed.`
                          )
                        }
                        disabled={agentWorking}
                        className="github-quick-action-btn"
                      >
                        📦 Check Build Status
                      </button>
                      {currentAgent?.takeoverModel && (
                        <button
                          type="button"
                          onClick={handleToggleTakeover}
                          disabled={busy || agentWorking}
                          className="github-quick-action-btn"
                          style={{ color: '#d97706', fontWeight: 650 }}
                        >
                          ⚡ Expert Takeover
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="github-chat-stream">
                    {messages.length === 0 ? (
                      <div className="github-empty-notice" style={{ margin: 'auto' }}>
                        <strong style={{ display: 'block', marginBottom: '4px', fontSize: '12px' }}>GitHub Operations Agent Ready</strong>
                        <p style={{ margin: 0, fontSize: '11px' }}>
                          Instruct the agent to triage issues live, prepare versioned releases, create pull requests, or monitor binary artifact compilation.
                        </p>
                      </div>
                    ) : (
                      messages.map((msg, i) => {
                        const isUser = msg.role === 'user';
                        return (
                          <div key={i} className={`github-msg ${isUser ? 'user' : 'assistant'}`}>
                            <div className="github-msg-bubble">{msg.content}</div>
                          </div>
                        );
                      })
                    )}
                    {agentWorking && (
                      <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: '11px', padding: '4px 8px' }}>
                        Agent is executing live operations on GitHub…
                      </div>
                    )}
                  </div>

                  <div className="github-composer">
                    <input
                      type="text"
                      placeholder={`Ask or instruct the agent about ${selectedRepo.name}…`}
                      value={composerInput}
                      onChange={(e) => setComposerInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      disabled={agentWorking}
                    />
                    <button
                      type="button"
                      onClick={() => handleSendMessage()}
                      disabled={agentWorking || !composerInput.trim()}
                      className="soft-button primary-button"
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}

              {/* Tab 2: Releases & Binaries */}
              {activeTab === 'releases' && (
                <div className="github-releases-panel">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <strong style={{ fontSize: '13px' }}>Versioned Releases & Binary Assets</strong>
                      <p style={{ margin: '2px 0 0', color: 'var(--muted)', fontSize: '11px' }}>
                        Automated GitHub releases with verified production binaries attached.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowReleaseModal(true)}
                      className="soft-button primary-button"
                    >
                      ＋ Create Release
                    </button>
                  </div>

                  {releases.length === 0 ? (
                    <div className="github-empty-notice">
                      No releases published yet for this repository.
                    </div>
                  ) : (
                    releases.map((rel) => (
                      <div key={rel.id} className="github-release-card">
                        <div className="github-release-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="github-release-title">{rel.name || rel.tag_name}</span>
                            <span className="github-release-tag">{rel.tag_name}</span>
                          </div>
                          <span style={{ color: 'var(--muted)', fontSize: '10.5px' }}>
                            {new Date(rel.created_at).toLocaleDateString()}
                          </span>
                        </div>

                        {rel.body && (
                          <div className="github-release-body">{rel.body}</div>
                        )}

                        {rel.assets.length > 0 && (
                          <div>
                            <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: '4px' }}>
                              Binary Assets ({rel.assets.length}):
                            </span>
                            <div className="github-release-assets">
                              {rel.assets.map((asset: GitHubReleaseAsset) => (
                                <a
                                  key={asset.id}
                                  href={asset.browser_download_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="github-asset-link"
                                >
                                  <span>📦</span> {asset.name}
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Tab 3: Workflows */}
              {activeTab === 'workflows' && (
                <div className="github-workflows-panel">
                  <div>
                    <strong style={{ fontSize: '13px' }}>GitHub Actions & CI/CD Builds</strong>
                    <p style={{ margin: '2px 0 0', color: 'var(--muted)', fontSize: '11px' }}>
                      Monitor workflow runs and automated binary artifact builds.
                    </p>
                  </div>

                  {workflowRuns.length === 0 ? (
                    <div className="github-empty-notice">No workflow runs found.</div>
                  ) : (
                    workflowRuns.map((run) => {
                      const isSuccess = run.conclusion === 'success';
                      const isFail = run.conclusion === 'failure';
                      const indicatorClass = isSuccess
                        ? 'success'
                        : isFail
                          ? 'failure'
                          : 'running';
                      return (
                        <div key={run.id} className="github-workflow-item">
                          <div className="github-workflow-left">
                            <span className={`github-status-indicator ${indicatorClass}`} />
                            <div>
                              <strong style={{ fontSize: '12px', display: 'block' }}>{run.name}</strong>
                              <span style={{ color: 'var(--muted)', fontSize: '10.5px' }}>
                                Branch: {run.head_branch} • Commit: {run.head_sha.slice(0, 7)}
                              </span>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                            <span style={{ textTransform: 'capitalize', color: 'var(--muted)' }}>
                              {run.conclusion || run.status}
                            </span>
                            <a
                              href={run.html_url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: 'var(--muted)', textDecoration: 'none' }}
                            >
                              ↗
                            </a>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="github-empty-notice" style={{ margin: 'auto' }}>
              <strong style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>Select a repository from the left panel</strong>
              <p style={{ marginBottom: '14px' }}>
                Or create a new project via the walkthrough wizard to start local development and live GitHub versioning.
              </p>
              <button
                type="button"
                onClick={() => {
                  setWizardStep(1);
                  setShowWizard(true);
                }}
                className="soft-button primary-button"
              >
                ＋ Create New Project
              </button>
            </div>
          )}
        </main>
      </div>

      {/* New Project Walkthrough Modal */}
      {showWizard && (
        <div className="github-modal-overlay" onClick={() => setShowWizard(false)}>
          <div className="github-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="github-modal-header">
              <div>
                <h3 className="github-modal-title">New GitHub Project Walkthrough</h3>
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  Step {wizardStep} of 4 • From local development to automated releases
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowWizard(false)}
                className="row-button"
              >
                ✕
              </button>
            </div>

            {/* Step 1: Repository Details */}
            {wizardStep === 1 && (
              <>
                <div className="github-form-group">
                  <label>Project Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. my-awesome-app"
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  />
                </div>

                <div className="github-form-group">
                  <label>Description</label>
                  <textarea
                    rows={2}
                    placeholder="Brief description of this repository…"
                    value={newProject.description}
                    onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                  />
                </div>

                <div className="github-form-group">
                  <label>Website</label>
                  <input
                    type="text"
                    placeholder="https://…"
                    value={newProject.website}
                    onChange={(e) => setNewProject({ ...newProject, website: e.target.value })}
                  />
                </div>

                <div className="github-form-group">
                  <label>Repository Topics</label>
                  <input
                    type="text"
                    placeholder="ai, agent, desktop, rust (separated by spaces or commas)"
                    value={topicsInput}
                    onChange={(e) => setTopicsInput(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600 }}>Visibility:</label>
                  <div style={{ display: 'flex', gap: '14px' }}>
                    <label className="github-checkbox-row">
                      <input
                        type="radio"
                        name="newProjectVisibility"
                        checked={!newProject.isPrivate}
                        onChange={() => setNewProject({ ...newProject, isPrivate: false })}
                      />
                      🌐 Public
                    </label>
                    <label className="github-checkbox-row">
                      <input
                        type="radio"
                        name="newProjectVisibility"
                        checked={Boolean(newProject.isPrivate)}
                        onChange={() => setNewProject({ ...newProject, isPrivate: true })}
                      />
                      🔒 Private
                    </label>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '6px', borderTop: '1px solid var(--line)' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600 }}>Include on repository overview:</label>
                  <label className="github-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newProject.includeReleases}
                      onChange={(e) => setNewProject({ ...newProject, includeReleases: e.target.checked })}
                    />
                    Releases (Automated version releases)
                  </label>
                  <label className="github-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newProject.includeDeployments}
                      onChange={(e) => setNewProject({ ...newProject, includeDeployments: e.target.checked })}
                    />
                    Deployments
                  </label>
                  <label className="github-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newProject.includePackages}
                      onChange={(e) => setNewProject({ ...newProject, includePackages: e.target.checked })}
                    />
                    Packages (Binary packages)
                  </label>
                </div>

                <div className="github-modal-actions">
                  <button type="button" onClick={() => setShowWizard(false)} className="row-button">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setWizardStep(2)}
                    disabled={!newProject.name.trim()}
                    className="soft-button primary-button"
                  >
                    Next: Template & CI/CD →
                  </button>
                </div>
              </>
            )}

            {/* Step 2: Templates & Scaffolding */}
            {wizardStep === 2 && (
              <>
                <div className="github-form-group">
                  <label>License</label>
                  <select
                    value={newProject.license}
                    onChange={(e) => setNewProject({ ...newProject, license: e.target.value as any })}
                  >
                    <option value="MIT">MIT License (Recommended)</option>
                    <option value="Apache-2.0">Apache License 2.0</option>
                    <option value="GPL-3.0">GNU General Public License v3.0</option>
                    <option value="None">No License</option>
                  </select>
                </div>

                <div className="github-form-group">
                  <label>Project Template</label>
                  <select
                    value={newProject.template}
                    onChange={(e) => setNewProject({ ...newProject, template: e.target.value as any })}
                  >
                    <option value="rust-tauri">Rust + Tauri Native Desktop App</option>
                    <option value="typescript-node">TypeScript + Node.js Package</option>
                    <option value="web-app">Modern React / Vite Web App</option>
                    <option value="python">Python / AI Service</option>
                    <option value="blank">Blank Scaffolding</option>
                  </select>
                </div>

                <div style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--line)', background: 'rgba(0,0,0,0.02)' }}>
                  <label className="github-checkbox-row" style={{ fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={newProject.setupActionsWorkflow}
                      onChange={(e) => setNewProject({ ...newProject, setupActionsWorkflow: e.target.checked })}
                    />
                    Generate automated GitHub Actions release workflow (.github/workflows/release.yml)
                  </label>
                  <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '10.5px' }}>
                    When a release tag is pushed (e.g. v0.2.0), GitHub will automatically compile and publish binary assets (e.g. AppImage / tar.gz).
                  </p>
                </div>

                <div className="github-modal-actions">
                  <button type="button" onClick={() => setWizardStep(1)} className="row-button">
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setWizardStep(3)}
                    className="soft-button primary-button"
                  >
                    Next: Local Workspace Phase →
                  </button>
                </div>
              </>
            )}

            {/* Step 3: Local Workspace Development Phase */}
            {wizardStep === 3 && (
              <>
                <div style={{ padding: '14px', borderRadius: '12px', border: '1px solid var(--line)', background: 'rgba(0,0,0,0.02)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <strong style={{ fontSize: '12.5px' }}>🛠️ Local Development Before Push</strong>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '11.5px', lineHeight: 1.5 }}>
                    While programming your initial version, code remains local inside your IRIS Workspace.
                  </p>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '11.5px', lineHeight: 1.5 }}>
                    Once satisfied with the first version, click <b>&quot;Create & Push to GitHub&quot;</b> to publish live.
                  </p>
                </div>

                <div className="github-modal-actions">
                  <button type="button" onClick={() => setWizardStep(2)} className="row-button">
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateProject}
                    disabled={wizardStatus !== 'idle'}
                    className="soft-button primary-button"
                  >
                    {wizardStatus === 'scaffolding'
                      ? 'Scaffolding locally…'
                      : wizardStatus === 'pushing'
                        ? 'Creating on GitHub…'
                        : '🚀 Create & Push to GitHub'}
                  </button>
                </div>
              </>
            )}

            {/* Step 4: Completed Walkthrough */}
            {wizardStep === 4 && (
              <div style={{ textAlign: 'center', padding: '16px 0', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '32px' }}>🎉</div>
                <strong style={{ fontSize: '14px' }}>Project Created & Release Automation Live!</strong>
                <p style={{ color: 'var(--muted)', fontSize: '11.5px', margin: 0 }}>
                  Your repository <b>{newProject.name}</b> is now live on GitHub with complete SemVer release pipelines.
                </p>
                <div style={{ paddingTop: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setShowWizard(false)}
                    className="soft-button primary-button"
                  >
                    Open Project in Workspace
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Release Creation Modal */}
      {showReleaseModal && (
        <div className="github-modal-overlay" onClick={() => setShowReleaseModal(false)}>
          <div className="github-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="github-modal-header">
              <h3 className="github-modal-title">Create New Release & Trigger Build</h3>
              <button
                type="button"
                onClick={() => setShowReleaseModal(false)}
                className="row-button"
              >
                ✕
              </button>
            </div>

            <div className="github-form-group">
              <label>SemVer Tag *</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  value={newReleaseTag}
                  onChange={(e) => setNewReleaseTag(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => setNewReleaseTag(bumpSemVer(newReleaseTag, 'patch'))}
                  className="soft-button"
                  style={{ fontSize: '10.5px', padding: '4px 8px' }}
                >
                  Patch
                </button>
                <button
                  type="button"
                  onClick={() => setNewReleaseTag(bumpSemVer(newReleaseTag, 'minor'))}
                  className="soft-button"
                  style={{ fontSize: '10.5px', padding: '4px 8px' }}
                >
                  Minor
                </button>
                <button
                  type="button"
                  onClick={() => setNewReleaseTag(bumpSemVer(newReleaseTag, 'major'))}
                  className="soft-button"
                  style={{ fontSize: '10.5px', padding: '4px 8px' }}
                >
                  Major
                </button>
              </div>
            </div>

            <div className="github-form-group">
              <label>Release Title</label>
              <input
                type="text"
                value={newReleaseTitle}
                onChange={(e) => setNewReleaseTitle(e.target.value)}
              />
            </div>

            <div className="github-form-group">
              <label>Release Notes & Changelog</label>
              <textarea
                rows={4}
                placeholder="Describe highlights, new features and fixes in this release…"
                value={newReleaseNotes}
                onChange={(e) => setNewReleaseNotes(e.target.value)}
              />
            </div>

            <div className="github-modal-actions">
              <button type="button" onClick={() => setShowReleaseModal(false)} className="row-button">
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePublishRelease}
                disabled={busy || !newReleaseTag.trim()}
                className="soft-button primary-button"
              >
                {busy ? 'Publishing…' : 'Publish Release & Trigger Build'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
