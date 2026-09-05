import type { NewProjectDraft } from '@iris/github';

export function GitHubProjectWizard({
  showWizard,
  setShowWizard,
  wizardStep,
  setWizardStep,
  newProject,
  setNewProject,
  topicsInput,
  setTopicsInput,
  wizardStatus,
  handleCreateProject,
}: {
  showWizard: boolean;
  setShowWizard: (value: boolean) => void;
  wizardStep: 1 | 2 | 3 | 4;
  setWizardStep: (value: 1 | 2 | 3 | 4) => void;
  newProject: NewProjectDraft;
  setNewProject: (value: NewProjectDraft) => void;
  topicsInput: string;
  setTopicsInput: (value: string) => void;
  wizardStatus: 'idle' | 'scaffolding' | 'pushing' | 'completed';
  handleCreateProject: () => Promise<void>;
}) {
  return (
    <>
      {' '}
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
              <button type="button" onClick={() => setShowWizard(false)} className="row-button">
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

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    paddingTop: '6px',
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  <label style={{ fontSize: '11px', fontWeight: 600 }}>
                    Include on repository overview:
                  </label>
                  <label className="github-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newProject.includeReleases}
                      onChange={(e) =>
                        setNewProject({ ...newProject, includeReleases: e.target.checked })
                      }
                    />
                    Releases (Automated version releases)
                  </label>
                  <label className="github-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newProject.includeDeployments}
                      onChange={(e) =>
                        setNewProject({ ...newProject, includeDeployments: e.target.checked })
                      }
                    />
                    Deployments
                  </label>
                  <label className="github-checkbox-row">
                    <input
                      type="checkbox"
                      checked={newProject.includePackages}
                      onChange={(e) =>
                        setNewProject({ ...newProject, includePackages: e.target.checked })
                      }
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
                    onChange={(e) =>
                      setNewProject({
                        ...newProject,
                        license: e.target.value as NewProjectDraft['license'],
                      })
                    }
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
                    onChange={(e) =>
                      setNewProject({
                        ...newProject,
                        template: e.target.value as NewProjectDraft['template'],
                      })
                    }
                  >
                    <option value="rust-tauri">Rust + Tauri Native Desktop App</option>
                    <option value="typescript-node">TypeScript + Node.js Package</option>
                    <option value="web-app">Modern React / Vite Web App</option>
                    <option value="python">Python / AI Service</option>
                    <option value="blank">Blank Scaffolding</option>
                  </select>
                </div>

                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'rgba(0,0,0,0.02)',
                  }}
                >
                  <label className="github-checkbox-row" style={{ fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={newProject.setupActionsWorkflow}
                      onChange={(e) =>
                        setNewProject({ ...newProject, setupActionsWorkflow: e.target.checked })
                      }
                    />
                    Generate automated GitHub Actions release workflow
                    (.github/workflows/release.yml)
                  </label>
                  <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '10.5px' }}>
                    When a release tag is pushed (e.g. v0.2.0), GitHub will automatically compile
                    and publish binary assets (e.g. AppImage / tar.gz).
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
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '12px',
                    border: '1px solid var(--line)',
                    background: 'rgba(0,0,0,0.02)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <strong style={{ fontSize: '12.5px' }}>🛠️ Local Development Before Push</strong>
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--muted)',
                      fontSize: '11.5px',
                      lineHeight: 1.5,
                    }}
                  >
                    While programming your initial version, code remains local inside your IRIS
                    Workspace.
                  </p>
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--muted)',
                      fontSize: '11.5px',
                      lineHeight: 1.5,
                    }}
                  >
                    Once satisfied with the first version, click{' '}
                    <b>&quot;Create GitHub Repository&quot;</b> to publish live.
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
                        : '🚀 Create GitHub Repository'}
                  </button>
                </div>
              </>
            )}

            {/* Step 4: Completed Walkthrough */}
            {wizardStep === 4 && (
              <div
                style={{
                  textAlign: 'center',
                  padding: '16px 0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div style={{ fontSize: '32px' }}>🎉</div>
                <strong style={{ fontSize: '14px' }}>
                  Repository created; files prepared locally
                </strong>
                <p style={{ color: 'var(--muted)', fontSize: '11.5px', margin: 0 }}>
                  Your repository <b>{newProject.name}</b> is now on GitHub. Generated files remain
                  in your local workspace; commit and push them before expecting workflows or binary
                  releases.
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
    </>
  );
}
