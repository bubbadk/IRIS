import type {
  AgentApprovalMode,
  AgentAutonomy,
  AgentMemoryAccess,
  ReasoningEffort,
} from '@iris/core';
import type { PermissionDecision } from '@iris/tools';
import { capabilityGroups, CapabilityPicker, skillGroups } from './AgentCapabilities';

import type { useAgentsWorkspace } from './useAgentsWorkspace';
export function AgentEditor({
  editor,
}: {
  editor: Pick<
    ReturnType<typeof useAgentsWorkspace>,
    | 'providers'
    | 'showEditor'
    | 'setShowEditor'
    | 'setEditingAgentId'
    | 'name'
    | 'setName'
    | 'description'
    | 'setDescription'
    | 'persona'
    | 'setPersona'
    | 'providerId'
    | 'setProviderId'
    | 'model'
    | 'setModel'
    | 'takeoverProviderId'
    | 'setTakeoverProviderId'
    | 'takeoverModel'
    | 'setTakeoverModel'
    | 'autonomy'
    | 'setAutonomy'
    | 'memoryAccess'
    | 'setMemoryAccess'
    | 'approvalMode'
    | 'setApprovalMode'
    | 'reasoningEffort'
    | 'setReasoningEffort'
    | 'editorToolIds'
    | 'editorToolPolicies'
    | 'availableSkills'
    | 'editorSkillIds'
    | 'capabilityPopup'
    | 'setCapabilityPopup'
    | 'availableAgentTools'
    | 'editorError'
    | 'setEditorError'
    | 'pendingApproval'
    | 'busy'
    | 'selectedProvider'
    | 'selectableModels'
    | 'selectedTakeoverProvider'
    | 'selectableTakeoverModels'
    | 'missingEditorSkillIds'
    | 'editingAgent'
    | 'toggleEditorSkill'
    | 'toggleEditorTool'
    | 'setEditorToolPolicy'
    | 'setGroupAuthority'
    | 'saveAgentConfiguration'
  >;
}) {
  const {
    providers,
    showEditor,
    setShowEditor,
    setEditingAgentId,
    name,
    setName,
    description,
    setDescription,
    persona,
    setPersona,
    providerId,
    setProviderId,
    model,
    setModel,
    takeoverProviderId,
    setTakeoverProviderId,
    takeoverModel,
    setTakeoverModel,
    autonomy,
    setAutonomy,
    memoryAccess,
    setMemoryAccess,
    approvalMode,
    setApprovalMode,
    reasoningEffort,
    setReasoningEffort,
    editorToolIds,
    editorToolPolicies,
    availableSkills,
    editorSkillIds,
    capabilityPopup,
    setCapabilityPopup,
    availableAgentTools,
    editorError,
    setEditorError,
    pendingApproval,
    busy,
    selectedProvider,
    selectableModels,
    selectedTakeoverProvider,
    selectableTakeoverModels,
    missingEditorSkillIds,
    editingAgent,
    toggleEditorSkill,
    toggleEditorTool,
    setEditorToolPolicy,
    setGroupAuthority,
    saveAgentConfiguration,
  } = editor;
  return (
    <>
      {' '}
      {showEditor && (
        <div className="agent-editor">
          <div className="editor-heading">
            <div>
              <p className="eyebrow">{editingAgent ? 'Edit agent' : 'Create agent'}</p>
              <h3>
                {editingAgent
                  ? `Configure ${editingAgent.name}.`
                  : 'A new worker for your workspace.'}
              </h3>
            </div>
            <button
              className="row-button"
              onClick={() => {
                setShowEditor(false);
                setEditingAgentId(null);
                setEditorError('');
              }}
            >
              Cancel
            </button>
          </div>
          <div className="agent-form-grid">
            <label>
              Agent name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Researcher"
              />
            </label>
            <label className="agent-description-field">
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What should this agent be responsible for?"
                rows={2}
              />
            </label>
            <label className="agent-persona-field">
              Persona / soul
              <textarea
                value={persona}
                onChange={(event) => setPersona(event.target.value)}
                placeholder="How should this agent think, speak and show up?"
                rows={3}
              />
              <small>Identity guidance only. It never grants tool authority.</small>
            </label>
            <label>
              Provider
              <select
                value={providerId}
                onChange={(event) => {
                  const nextProvider = providers.find(
                    (provider) => provider.id === event.target.value,
                  );
                  setProviderId(event.target.value);
                  setModel(nextProvider?.model ?? '');
                }}
              >
                <option value="">Choose a provider…</option>
                {providerId && !selectedProvider && (
                  <option value={providerId}>Unavailable provider · {providerId}</option>
                )}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select
                value={model}
                disabled={!selectedProvider}
                onChange={(event) => setModel(event.target.value)}
              >
                {!selectedProvider && (
                  <option value={model}>
                    {model || (providerId ? 'Provider unavailable' : 'Choose a provider first…')}
                  </option>
                )}
                {selectableModels.map((availableModel) => (
                  <option key={availableModel} value={availableModel}>
                    {availableModel}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ⚡ Takeover Provider (Expert AI)
              <select
                value={takeoverProviderId}
                onChange={(event) => {
                  const nextProvider = providers.find(
                    (provider) => provider.id === event.target.value,
                  );
                  setTakeoverProviderId(event.target.value);
                  setTakeoverModel(nextProvider?.model ?? '');
                }}
              >
                <option value="">No takeover (default)</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    ⚡ {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ⚡ Takeover Model
              <select
                value={takeoverModel}
                disabled={!selectedTakeoverProvider}
                onChange={(event) => setTakeoverModel(event.target.value)}
              >
                {!selectedTakeoverProvider && (
                  <option value="">
                    {takeoverProviderId
                      ? 'Provider unavailable'
                      : 'Choose a takeover provider first…'}
                  </option>
                )}
                {selectableTakeoverModels.map((availableModel) => (
                  <option key={availableModel} value={availableModel}>
                    {availableModel}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Autonomy
              <select
                value={autonomy}
                onChange={(event) => setAutonomy(event.target.value as AgentAutonomy)}
              >
                <option value="observe">Observe</option>
                <option value="assist">Assist</option>
                <option value="act">Act</option>
                <option value="operate">Operate</option>
                <option value="janitor">Janitor</option>
                <option value="github">GitHub</option>
              </select>
            </label>
            <label>
              Memory access
              <select
                value={memoryAccess}
                onChange={(event) => setMemoryAccess(event.target.value as AgentMemoryAccess)}
              >
                <option value="none">No access</option>
                <option value="read">Read saved memory</option>
              </select>
            </label>
            <label>
              Tool approval mode
              <select
                value={approvalMode}
                onChange={(event) => setApprovalMode(event.target.value as AgentApprovalMode)}
              >
                <option value="ask">Ask before tools run</option>
                <option value="yolo">YOLO · run assigned tools</option>
              </select>
            </label>
            <label>
              Reasoning effort
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
              >
                <option value="none">None · provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
          {reasoningEffort !== 'none' && (
            <p className="agent-capabilities-warning">
              Not every model or provider honors a reasoning-effort request; unsupported ones simply
              ignore it and answer as usual.
            </p>
          )}
          {approvalMode === 'yolo' && (
            <p className="agent-capabilities-warning">
              YOLO skips approvals for this agent&apos;s assigned tools. Tools without assignment
              remain blocked, and an explicit Deny rule still wins. Use this only for trusted
              agents.
            </p>
          )}
          <section className="agent-capabilities" aria-label="Agent tools">
            <div className="agent-capabilities-heading">
              <div>
                <p className="eyebrow">Assigned tools</p>
                <h4>Choose what the model can request.</h4>
              </div>
              <button
                className="capability-summary-button"
                onClick={() => setCapabilityPopup('tools')}
              >
                {editorToolIds.length} assigned · Choose by source
              </button>
            </div>
            <p className="agent-capabilities-note">
              Assignment exposes a tool to this agent. Authority remains explicit. New assignments
              default to Ask, so you can approve the exact request in the conversation.
            </p>
            <div className="agent-tool-options agent-tool-options-compact">
              {availableAgentTools.map((tool) => {
                const assigned = editorToolIds.includes(tool.id);
                return (
                  <article
                    className={`agent-tool-option ${assigned ? 'assigned' : ''}`}
                    key={tool.id}
                  >
                    <label className="agent-tool-assignment">
                      <input
                        type="checkbox"
                        checked={assigned}
                        onChange={(event) => toggleEditorTool(tool.id, event.target.checked)}
                      />
                      <span>
                        <strong>{tool.name}</strong>
                        <small>{tool.description}</small>
                      </span>
                      <em>{tool.risk}</em>
                    </label>
                    <label className="agent-tool-authority">
                      Authority
                      <select
                        value={editorToolPolicies[tool.id] || 'ask'}
                        disabled={!assigned}
                        onChange={(event) =>
                          setEditorToolPolicy(tool.id, event.target.value as PermissionDecision)
                        }
                      >
                        <option value="ask">Ask every time</option>
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                    </label>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="agent-capabilities" aria-label="Agent skills">
            <div className="agent-capabilities-heading">
              <div>
                <p className="eyebrow">Assigned skills</p>
                <h4>Choose how this agent should work.</h4>
              </div>
              <button
                className="capability-summary-button"
                onClick={() => setCapabilityPopup('skills')}
              >
                {editorSkillIds.length} assigned · Choose by source
              </button>
            </div>
            <p className="agent-capabilities-note">
              Only assigned skills that are enabled in Skills are injected into a turn. A skill is
              instruction text, never tool authority.
            </p>
            {availableSkills.length === 0 ? (
              <p className="agent-note">
                No skill exists yet. Create one in the Skills object before assigning it here.
              </p>
            ) : (
              <div className="agent-tool-options">
                {availableSkills.map((skill) => {
                  const assigned = editorSkillIds.includes(skill.id);
                  return (
                    <article
                      className={`agent-tool-option ${assigned ? 'assigned' : ''}`}
                      key={skill.id}
                    >
                      <label className="agent-tool-assignment">
                        <input
                          type="checkbox"
                          checked={assigned}
                          onChange={(event) => toggleEditorSkill(skill.id, event.target.checked)}
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small>{skill.summary || 'No summary.'}</small>
                        </span>
                        <em>{skill.enabled ? 'enabled' : 'disabled'}</em>
                      </label>
                    </article>
                  );
                })}
              </div>
            )}
            {missingEditorSkillIds.length > 0 && (
              <p className="agent-note">
                {missingEditorSkillIds.length} stored assignment
                {missingEditorSkillIds.length === 1 ? '' : 's'} point to skills that no longer exist
                and will be dropped when you save.
              </p>
            )}
          </section>
          {capabilityPopup && (
            <CapabilityPicker
              title={
                capabilityPopup === 'tools' ? 'Choose tools by source' : 'Choose skills by source'
              }
              groups={
                capabilityPopup === 'tools'
                  ? capabilityGroups(availableAgentTools)
                  : skillGroups(availableSkills)
              }
              selectedIds={capabilityPopup === 'tools' ? editorToolIds : editorSkillIds}
              onToggle={capabilityPopup === 'tools' ? toggleEditorTool : toggleEditorSkill}
              onGroupAuthority={capabilityPopup === 'tools' ? setGroupAuthority : undefined}
              onClose={() => setCapabilityPopup(null)}
            />
          )}
          {providers.length === 0 && (
            <p className="agent-note">
              Configure a provider in Models before asking an agent to run.
            </p>
          )}
          {editorError && <p className="agent-editor-error">{editorError}</p>}
          <button
            className="soft-button primary-button"
            disabled={busy || Boolean(pendingApproval)}
            onClick={saveAgentConfiguration}
          >
            {editingAgent ? 'Save agent' : 'Create agent'}
          </button>
        </div>
      )}
    </>
  );
}
