import { useEffect, useMemo, useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import {
  skillInstructionsLimit,
  skillOrigin,
  describeSkillBundle,
  describeSkillBundleProvenance,
  parseSkillBundleDraft,
  serializeSkillBundleDraft,
  skillSummaryLimit,
  type SkillDefinition,
  type ImportedSkillSourceCheck,
} from '@iris/skills';
import { agentRepository } from './persistence';
import { SkillCatalogBrowser } from './SkillCatalogBrowser';
import {
  createSkillDefinition,
  listSkills,
  removeSkillDefinition,
  setSkillEnabled,
  subscribeSkills,
  updateSkillDefinition,
  setSkillBundleDefinition,
  checkImportedSkillSource,
  updateImportedSkillFromSource,
} from './skills';
import { skillCapabilityStatus } from './skillCapabilities';
import { sourceReviewBelongsToSkill } from './skillSourceReview';
import { DiffViewer } from './DiffViewer';

function formatSkillDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function describeOrigin(skill: SkillDefinition): string {
  const origin = skillOrigin(skill);
  if (origin.kind === 'imported') return `Imported from ${origin.catalogName} · ${origin.slug}`;
  if (origin.kind === 'captured') {
    return `Captured by ${origin.agentName} · ${formatSkillDate(origin.capturedAt)}`;
  }
  return 'Written here';
}

const emptyDraft = { name: '', summary: '', instructions: '' };
const bundleManifestExample = JSON.stringify(
  {
    files: [{ path: 'templates/example.md', content: '# Add a bounded local file' }],
    toolDeclarations: [],
  },
  null,
  2,
);

export function SkillsState() {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'installed' | 'catalog'>('installed');
  const [sourceCheck, setSourceCheck] = useState<ImportedSkillSourceCheck | null>(null);
  const [sourceCheckSkillId, setSourceCheckSkillId] = useState<string | null>(null);
  const [checkingSource, setCheckingSource] = useState(false);
  const [bundleEditorOpen, setBundleEditorOpen] = useState(false);
  const [bundleDraft, setBundleDraft] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      const [storedSkills, storedAgents] = await Promise.all([
        listSkills(),
        agentRepository.list(),
      ]);
      if (!active) return;
      setSkills(storedSkills);
      setAgents(storedAgents);
      setSelectedId((current) =>
        current && storedSkills.some((skill) => skill.id === current)
          ? current
          : (storedSkills[0]?.id ?? null),
      );
      setLoaded(true);
    }
    void load();
    const unsubscribe = subscribeSkills(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setSourceCheck(null);
    setSourceCheckSkillId(null);
  }, [selectedId]);

  const selected = useMemo(
    () => skills.find((skill) => skill.id === selectedId) ?? null,
    [selectedId, skills],
  );

  const assignedAgents = useMemo(
    () => (selected ? agents.filter((agent) => agent.skillIds.includes(selected.id)) : []),
    [agents, selected],
  );

  const importedOrigin =
    selected && skillOrigin(selected).kind === 'imported' ? skillOrigin(selected) : null;

  function startCreating() {
    setEditingId(null);
    setDraft(emptyDraft);
    setShowEditor(true);
    setBundleEditorOpen(true);
    setBundleDraft('');
    setError('');
  }

  function startEditing(skill: SkillDefinition) {
    setEditingId(skill.id);
    setDraft({ name: skill.name, summary: skill.summary, instructions: skill.instructions });
    setBundleEditorOpen(false);
    setBundleDraft(skill.bundle ? serializeSkillBundleDraft(skill.bundle) : '');
    setShowEditor(true);
    setError('');
  }

  function startEditingBundle(skill: SkillDefinition) {
    setEditingId(skill.id);
    setDraft({ name: skill.name, summary: skill.summary, instructions: skill.instructions });
    setBundleEditorOpen(true);
    setBundleDraft(skill.bundle ? serializeSkillBundleDraft(skill.bundle) : bundleManifestExample);
    setShowEditor(true);
    setError('');
  }

  async function checkSource(skill: SkillDefinition) {
    setCheckingSource(true);
    setError('');
    setSourceCheck(null);
    setSourceCheckSkillId(skill.id);
    try {
      setSourceCheck(await checkImportedSkillSource(skill.id));
    } catch (checkError) {
      setSourceCheckSkillId(null);
      setError(
        checkError instanceof Error ? checkError.message : 'IRIS could not check this source.',
      );
    } finally {
      setCheckingSource(false);
    }
  }

  async function acceptSourceUpdate(skill: SkillDefinition) {
    if (
      !sourceCheck?.proposedText ||
      (sourceCheck.status !== 'changed' && sourceCheck.status !== 'moved')
    )
      return;
    setBusy(true);
    setError('');
    try {
      const saved = await updateImportedSkillFromSource(
        skill.id,
        sourceCheck.proposedText,
        sourceCheck.checkedAt,
        sourceCheck.sourceUrl,
      );
      setSelectedId(saved.id);
      setSourceCheck(null);
      setSourceCheckSkillId(null);
    } catch (updateError) {
      setError(
        updateError instanceof Error ? updateError.message : 'IRIS could not update this skill.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    setBusy(true);
    setError('');
    try {
      const bundle = bundleEditorOpen
        ? bundleDraft.trim()
          ? parseSkillBundleDraft(bundleDraft)
          : undefined
        : undefined;
      const existing = editingId ? skills.find((skill) => skill.id === editingId) : null;
      const saved = editingId
        ? await updateSkillDefinition(editingId, { ...draft, enabled: existing?.enabled ?? true })
        : await createSkillDefinition({ ...draft, enabled: true });
      if (bundleEditorOpen) {
        await setSkillBundleDefinition(saved.id, bundle);
      }
      setSelectedId(saved.id);
      setShowEditor(false);
      setEditingId(null);
      setBundleEditorOpen(false);
      setDraft(emptyDraft);
      setBundleDraft('');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'IRIS could not save this skill.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(skill: SkillDefinition) {
    setBusy(true);
    setError('');
    try {
      await setSkillEnabled(skill.id, !skill.enabled);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : 'IRIS could not change this skill.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function forget(skill: SkillDefinition) {
    setBusy(true);
    setError('');
    try {
      await removeSkillDefinition(skill.id);
      if (selectedId === skill.id) setSelectedId(null);
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : 'IRIS could not delete this skill.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skills-state">
      <header className="skills-heading">
        <div>
          <p className="eyebrow">Local skills</p>
          <h2>Teach a repeatable way of working.</h2>
          <p>
            A skill is instruction text you author. Assigned, enabled skills are injected into each
            turn of an agent. A skill never grants tool authority.
          </p>
        </div>
        <button className="soft-button primary-button" disabled={busy} onClick={startCreating}>
          + New skill
        </button>
      </header>

      <div className="skills-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === 'installed'}
          className={view === 'installed' ? 'selected' : ''}
          onClick={() => setView('installed')}
        >
          Your skills · {skills.length}
        </button>
        <button
          role="tab"
          aria-selected={view === 'catalog'}
          className={view === 'catalog' ? 'selected' : ''}
          onClick={() => setView('catalog')}
        >
          Browse directory
        </button>
      </div>

      {view === 'installed' && showEditor && (
        <section className="skill-editor" aria-label="Skill editor">
          <p className="eyebrow">{editingId ? 'Edit skill' : 'New skill'}</p>
          <label>
            Name
            <input
              value={draft.name}
              placeholder="Release checklist"
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          {(bundleEditorOpen || !editingId) && (
            <section className="skill-bundle-editor" aria-label="Bundled skill material editor">
              <div>
                <p className="eyebrow">Optional bundled material</p>
                <p>
                  Store bounded files and descriptive <code>skill.*</code> capability declarations.
                  Declarations never create runtime authority; every capability still needs a host
                  provider, assignment and permission.
                </p>
              </div>
              <textarea
                rows={10}
                value={bundleDraft}
                placeholder={bundleManifestExample}
                onChange={(event) => setBundleDraft(event.target.value)}
                aria-label="Bundle manifest JSON"
              />
              <small>Leave empty to remove the bundle. JSON is validated before persistence.</small>
            </section>
          )}
          <label>
            Summary
            <input
              value={draft.summary}
              maxLength={skillSummaryLimit}
              placeholder="What this skill is for."
              onChange={(event) =>
                setDraft((current) => ({ ...current, summary: event.target.value }))
              }
            />
          </label>
          <label>
            Instructions
            <textarea
              rows={8}
              value={draft.instructions}
              placeholder="Write the operating guidance the agent should follow."
              onChange={(event) =>
                setDraft((current) => ({ ...current, instructions: event.target.value }))
              }
            />
          </label>
          <div className="skill-editor-footer">
            <small>
              {draft.instructions.length} / {skillInstructionsLimit} characters
            </small>
            <div className="skill-editor-actions">
              <button
                className="row-button"
                disabled={busy}
                onClick={() => {
                  setShowEditor(false);
                  setEditingId(null);
                  setError('');
                }}
              >
                Cancel
              </button>
              <button
                className="soft-button primary-button"
                disabled={busy}
                onClick={() => void saveDraft()}
              >
                {editingId ? 'Save skill' : 'Create skill'}
              </button>
            </div>
          </div>
        </section>
      )}

      {error && <p className="skills-error">{error}</p>}

      {view === 'catalog' ? (
        <SkillCatalogBrowser
          installed={skills}
          onImported={(skill) => {
            setSelectedId(skill.id);
            setView('installed');
          }}
        />
      ) : !loaded ? (
        <div className="skills-empty">Loading local skills…</div>
      ) : skills.length === 0 ? (
        <div className="skills-empty">
          <strong>No skills yet</strong>
          <p>
            Create one above. Until a skill is created, assigned and enabled, nothing is injected
            into any agent turn.
          </p>
        </div>
      ) : (
        <div className="skills-browser">
          <aside className="skills-list">
            {skills.map((skill) => (
              <button
                key={skill.id}
                className={`skill-row ${skill.id === selectedId ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(skill.id);
                  setSourceCheck(null);
                  setSourceCheckSkillId(null);
                }}
              >
                <strong>{skill.name}</strong>
                <small>{skill.enabled ? 'Enabled' : 'Disabled'}</small>
              </button>
            ))}
          </aside>
          {selected && (
            <section className="skill-detail" aria-label="Selected skill">
              <div className="skill-detail-heading">
                <div>
                  <p className="eyebrow">Skill</p>
                  <h3>{selected.name}</h3>
                </div>
                <div className="skill-detail-actions">
                  <button
                    className="row-button"
                    disabled={busy}
                    onClick={() => void toggleEnabled(selected)}
                  >
                    {selected.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="row-button"
                    disabled={busy}
                    onClick={() => startEditing(selected)}
                  >
                    Edit
                  </button>
                  {skillOrigin(selected).kind !== 'imported' && (
                    <button
                      className="row-button"
                      disabled={busy}
                      onClick={() => startEditingBundle(selected)}
                    >
                      {selected.bundle ? 'Edit bundle' : 'Add bundle'}
                    </button>
                  )}
                  <button
                    className="row-button"
                    disabled={busy}
                    onClick={() => void forget(selected)}
                  >
                    Delete
                  </button>
                  {skillOrigin(selected).kind === 'imported' && (
                    <button
                      className="row-button"
                      disabled={busy || checkingSource}
                      onClick={() => void checkSource(selected)}
                    >
                      {checkingSource ? 'Checking…' : 'Check source'}
                    </button>
                  )}
                </div>
              </div>
              {selected.summary && <p className="skill-summary">{selected.summary}</p>}
              {selected.bundle && (
                <section className="skill-bundle" aria-label="Bundled skill material">
                  <div className="skill-bundle-heading">
                    <div>
                      <p className="eyebrow">Bundled material</p>
                      <h4>{describeSkillBundle(selected.bundle)}</h4>
                    </div>
                    <span className="skill-bundle-provenance">
                      {describeSkillBundleProvenance(selected.bundle)}
                    </span>
                  </div>
                  <p className="skill-bundle-notice">
                    Bundled files stay inside this skill. A supported read-only capability may be
                    registered at runtime, but declarations never grant authority on their own.
                  </p>
                  {selected.bundle.files.length > 0 && (
                    <div className="skill-bundle-files">
                      <p className="skill-bundle-label">Files</p>
                      {selected.bundle.files.map((file) => (
                        <details key={file.path} className="skill-bundle-file">
                          <summary>
                            <code>{file.path}</code>
                            <span>{file.content.length.toLocaleString()} characters</span>
                          </summary>
                          <pre>{file.content}</pre>
                        </details>
                      ))}
                    </div>
                  )}
                  {selected.bundle.toolDeclarations.length > 0 && (
                    <div className="skill-bundle-tools">
                      <p className="skill-bundle-label">Declared capabilities</p>
                      {selected.bundle.toolDeclarations.map((tool) => (
                        <article key={tool.id} className="skill-bundle-tool">
                          <div>
                            <strong>{tool.name}</strong>
                            <code>{tool.id}</code>
                          </div>
                          <span className="skill-bundle-risk">{tool.risk} risk</span>
                          <small className="skill-bundle-status">
                            {skillCapabilityStatus(selected, tool.id).status === 'registered'
                              ? 'Provider registered · still needs assignment and permission'
                              : 'Unavailable · no runtime provider registered'}
                          </small>
                          <p>{tool.description}</p>
                        </article>
                      ))}
                    </div>
                  )}
                  {selected.bundle.provenance === 'imported' && selected.bundle.source && (
                    <dl className="skill-bundle-source">
                      <div>
                        <dt>Recorded source</dt>
                        <dd>
                          {selected.bundle.source.url ? (
                            <a href={selected.bundle.source.url} target="_blank" rel="noreferrer">
                              {selected.bundle.source.url}
                            </a>
                          ) : (
                            'No source address recorded'
                          )}
                        </dd>
                      </div>
                      {selected.bundle.source.fingerprint && (
                        <div>
                          <dt>Source fingerprint</dt>
                          <dd>
                            <code>{selected.bundle.source.fingerprint}</code>
                          </dd>
                        </div>
                      )}
                      {selected.bundle.source.lastCheckedAt && (
                        <div>
                          <dt>Last review</dt>
                          <dd>
                            {selected.bundle.source.lastCheck ?? 'unknown'} ·{' '}
                            {formatSkillDate(selected.bundle.source.lastCheckedAt)}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}
                </section>
              )}
              {sourceCheck &&
                sourceReviewBelongsToSkill(sourceCheckSkillId, selected.id) &&
                skillOrigin(selected).kind === 'imported' && (
                  <section className="skill-source-check" aria-label="Source update review">
                    <p className="eyebrow">Source check · {sourceCheck.status}</p>
                    {sourceCheck.status === 'unchanged' && <p>The original source is unchanged.</p>}
                    {sourceCheck.status === 'unavailable' && (
                      <p>
                        The original source is unavailable. Your local skill was kept unchanged.
                      </p>
                    )}
                    {sourceCheck.status === 'moved' && (
                      <p>
                        The source was found at a new document address. Review it before accepting.
                      </p>
                    )}
                    {sourceCheck.status === 'changed' && (
                      <p>
                        The source changed. Your local instructions remain active until you accept.
                      </p>
                    )}
                    {sourceCheck.proposedText &&
                      (sourceCheck.status === 'changed' || sourceCheck.status === 'moved') && (
                        <>
                          <DiffViewer
                            originalText={sourceCheck.previousText}
                            modifiedText={sourceCheck.proposedText}
                            title="Instruction diff · local versus source"
                          />
                          <button
                            className="soft-button primary-button"
                            disabled={busy}
                            onClick={() => void acceptSourceUpdate(selected)}
                          >
                            Accept source update
                          </button>
                        </>
                      )}
                  </section>
                )}
              <pre className="skill-instructions">{selected.instructions}</pre>
              <dl className="skill-meta">
                <div>
                  <dt>State</dt>
                  <dd>
                    {selected.enabled
                      ? 'Enabled · injected when assigned'
                      : 'Disabled · never injected'}
                  </dd>
                </div>
                <div>
                  <dt>Assigned to</dt>
                  <dd>
                    {assignedAgents.length
                      ? assignedAgents.map((agent) => agent.name).join(', ')
                      : 'No agent yet'}
                  </dd>
                </div>
                <div>
                  <dt>Origin</dt>
                  <dd>{describeOrigin(selected)}</dd>
                </div>
                {importedOrigin?.kind === 'imported' && importedOrigin.lastCheckedAt && (
                  <div>
                    <dt>Source status</dt>
                    <dd>
                      {importedOrigin.lastCheck} · checked{' '}
                      {formatSkillDate(importedOrigin.lastCheckedAt)}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Updated</dt>
                  <dd>{formatSkillDate(selected.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Skill ID</dt>
                  <dd>
                    <code>{selected.id}</code>
                  </dd>
                </div>
              </dl>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
