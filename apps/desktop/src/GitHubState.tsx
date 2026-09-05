import type { GitHubReleaseAsset } from '@iris/github';
import { ToolRequestView } from './ChatContent';
import { GitHubProjectWizard } from './GitHubProjectWizard';
import { GitHubReleaseDialog } from './GitHubReleaseDialog';
import { GitHubIcon } from './icons';
import { ModelHandoffMarker } from './ModelHandoffMarker';
import { chatSessions } from './useChatSession';

import { useGitHubWorkspace } from './useGitHubWorkspace';
export function GitHubState() {
  const {
    authStatus,
    tokenInput,
    setTokenInput,
    loading,
    busy,
    error,
    setError,
    repos,
    repoSearch,
    setRepoSearch,
    selectedRepo,
    setSelectedRepo,
    activeTab,
    setActiveTab,
    releases,
    workflows,
    workflowRuns,
    issues,
    agents,
    selectedAgentId,
    setSelectedAgentId,
    composerInput,
    setComposerInput,
    messages,
    agentWorking,
    assistantDraft,
    approval,
    approvalInput,
    agentActivity,
    agentError,
    showWizard,
    setShowWizard,
    wizardStep,
    setWizardStep,
    newProject,
    setNewProject,
    topicsInput,
    setTopicsInput,
    wizardStatus,
    showReleaseModal,
    setShowReleaseModal,
    newReleaseTag,
    setNewReleaseTag,
    newReleaseTitle,
    setNewReleaseTitle,
    newReleaseNotes,
    setNewReleaseNotes,
    handleSignIn,
    handleSignOut,
    handleSendMessage,
    handleCreateProject,
    handlePublishRelease,
    handleToggleVisibility,
    handleToggleTakeover,
    filteredRepos,
    currentAgent,
  } = useGitHubWorkspace();
  if (loading) {
    return (
      <div className="github-state">
        <div className="github-empty-notice">Loading GitHub Operating Environment...</div>
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
            Manage repositories, triage issues with specialist GitHub agents, and ship automated
            binary releases.
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
              <button type="button" onClick={handleSignOut} disabled={busy} className="soft-button">
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
          <button
            type="button"
            onClick={() => setError('')}
            style={{
              float: 'right',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
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
              <div
                className="github-empty-notice"
                style={{ margin: '20px 10px', fontSize: '11px' }}
              >
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
                    {repo.description && <p className="github-repo-desc">{repo.description}</p>}
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
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '8px',
                        fontSize: '11px',
                      }}
                    >
                      <span style={{ color: 'var(--muted)', fontWeight: 600 }}>Active Agent:</span>
                      <select
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        style={{
                          padding: '3px 8px',
                          borderRadius: '6px',
                          border: '1px solid var(--line)',
                          background: 'var(--surface)',
                          fontSize: '11px',
                        }}
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
                            `Review open issues for ${selectedRepo.name}, diagnose root causes and propose surgical pull requests.`,
                          )
                        }
                        disabled={agentWorking || Boolean(approval)}
                        className="github-quick-action-btn"
                      >
                        🐞 Triage Issues ({issues.length})
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            `Prepare a versioned release: bump SemVer version, generate changelog notes, and trigger the GitHub release workflow for binary builds.`,
                          )
                        }
                        disabled={agentWorking || Boolean(approval)}
                        className="github-quick-action-btn"
                      >
                        🚀 Automate Release
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            `Check the status of recent GitHub Actions CI/CD runs and verify if binary artifact builds passed.`,
                          )
                        }
                        disabled={agentWorking || Boolean(approval)}
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
                        <strong style={{ display: 'block', marginBottom: '4px', fontSize: '12px' }}>
                          GitHub Operations Agent Ready
                        </strong>
                        <p style={{ margin: 0, fontSize: '11px' }}>
                          Instruct the agent to triage issues live, prepare versioned releases,
                          create pull requests, or monitor binary artifact compilation.
                        </p>
                      </div>
                    ) : (
                      messages.map((msg, i) => {
                        if (msg.role === 'handoff') {
                          return (
                            <ModelHandoffMarker
                              key={`handoff-${msg.handoff?.at ?? i}`}
                              message={msg}
                            />
                          );
                        }
                        const isUser = msg.role === 'user';
                        return (
                          <div key={i} className={`github-msg ${isUser ? 'user' : 'assistant'}`}>
                            <div className="github-msg-bubble">{msg.content}</div>
                          </div>
                        );
                      })
                    )}
                    {assistantDraft && (
                      <div className="github-msg assistant">
                        <div className="github-msg-bubble">{assistantDraft}</div>
                      </div>
                    )}
                    {agentError && (
                      <p role="alert" className="workspace-error">
                        {agentError}
                      </p>
                    )}
                    {approval && (
                      <section className="approval-panel">
                        <strong>{approval.toolName} needs your approval</strong>
                        <ToolRequestView input={approvalInput} />
                        <button
                          className="row-button"
                          disabled={agentWorking}
                          onClick={() => void chatSessions.resolve(selectedAgentId, 'approve')}
                        >
                          Apply
                        </button>
                        <button
                          className="row-button"
                          disabled={agentWorking}
                          onClick={() => void chatSessions.resolve(selectedAgentId, 'deny')}
                        >
                          Deny
                        </button>
                      </section>
                    )}
                    {agentWorking && (
                      <div
                        style={{
                          color: 'var(--muted)',
                          fontStyle: 'italic',
                          fontSize: '11px',
                          padding: '4px 8px',
                        }}
                      >
                        {agentActivity || 'Waiting for the agent…'}
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
                      disabled={agentWorking || Boolean(approval)}
                    />
                    <button
                      type="button"
                      onClick={() => handleSendMessage()}
                      disabled={agentWorking || Boolean(approval) || !composerInput.trim()}
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
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: '13px' }}>
                        Versioned Releases & Binary Assets
                      </strong>
                      <p style={{ margin: '2px 0 0', color: 'var(--muted)', fontSize: '11px' }}>
                        Published releases and the assets currently attached to each release.
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

                        {rel.body && <div className="github-release-body">{rel.body}</div>}

                        {rel.assets.length > 0 && (
                          <div>
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                color: 'var(--muted)',
                                display: 'block',
                                marginBottom: '4px',
                              }}
                            >
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
                      const indicatorClass = isSuccess ? 'success' : isFail ? 'failure' : 'running';
                      return (
                        <div key={run.id} className="github-workflow-item">
                          <div className="github-workflow-left">
                            <span className={`github-status-indicator ${indicatorClass}`} />
                            <div>
                              <strong style={{ fontSize: '12px', display: 'block' }}>
                                {run.name}
                              </strong>
                              <span style={{ color: 'var(--muted)', fontSize: '10.5px' }}>
                                Branch: {run.head_branch} • Commit: {run.head_sha.slice(0, 7)}
                              </span>
                            </div>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              fontSize: '11px',
                            }}
                          >
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
              <strong style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>
                Select a repository from the left panel
              </strong>
              <p style={{ marginBottom: '14px' }}>
                Or create a new project via the walkthrough wizard to start local development and
                live GitHub versioning.
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

      <GitHubProjectWizard
        showWizard={showWizard}
        setShowWizard={setShowWizard}
        wizardStep={wizardStep}
        setWizardStep={setWizardStep}
        newProject={newProject}
        setNewProject={setNewProject}
        topicsInput={topicsInput}
        setTopicsInput={setTopicsInput}
        wizardStatus={wizardStatus}
        handleCreateProject={handleCreateProject}
      />
      <GitHubReleaseDialog
        showReleaseModal={showReleaseModal}
        setShowReleaseModal={setShowReleaseModal}
        newReleaseTag={newReleaseTag}
        setNewReleaseTag={setNewReleaseTag}
        newReleaseTitle={newReleaseTitle}
        setNewReleaseTitle={setNewReleaseTitle}
        newReleaseNotes={newReleaseNotes}
        setNewReleaseNotes={setNewReleaseNotes}
        handlePublishRelease={handlePublishRelease}
        busy={busy}
      />
    </div>
  );
}
