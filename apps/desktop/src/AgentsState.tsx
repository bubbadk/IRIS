import { useEffect, useMemo, useRef, useState } from 'react';
import { type AgentEvent, type AgentToolApproval, type ConversationMessage } from '@iris/agents';
import {
  type ContextPack,
  type CortexTurnRecord,
  type CortexTurnStep,
} from '@iris/cortex';
import type {
  AgentApprovalMode,
  AgentAutonomy,
  AgentDefinition,
  AgentMemoryAccess,
  ReasoningEffort,
} from '@iris/core';
import { skillOrigin, type SkillDefinition } from '@iris/skills';
import type { PermissionDecision, ToolDefinition } from '@iris/tools';
import {
  loadProviderConfigs,
  subscribeProviderConfigs,
  type ModelImage,
  type ProviderConfig,
} from '@iris/providers';
import { readAttachmentFile, type ComposerAttachment } from './attachments';
import { agentRuntime, normalizeDesktopAgent, subscribeAgentRuntime } from './agentRuntime';
import { recordUserActivity } from './userActivity';
import { applyAgentConfiguration } from './agentConfiguration';
import {
  editableAgentToolPolicies,
  ensureAssignedToolsRequireApproval,
  saveAgentToolPolicies,
  type AgentToolPolicies,
} from './agentPermissions';
import { displayedAgentModel, selectableAgentModels } from './agentModelSelection';
import {
  RichMessage,
  MessageImages,
  AttachmentChips,
  AttachButton,
  composerDropHandlers,
  formatElapsed,
  shortToolLabel,
  ToolRequestView,
  formatMemoryDate,
} from './App';
import {
  agentRepository,
  contextPackRepository,
  conversationRepository,
  cortexTurnStepRepository,
  permissionRuleRepository,
} from './persistence';
import { formatCount } from './systemTelemetry';
import { listSkills, subscribeSkills } from './skills';
import { subscribeMcpServers } from './mcp';
import { toolRegistry } from './tooling';

export interface CapabilityGroup {
  id: string;
  label: string;
  description: string;
  items: Array<{ id: string; name: string; description: string; meta: string }>;
}

function capabilityGroups(tools: readonly ToolDefinition[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>();
  for (const tool of tools) {
    const mcp = tool.id.match(/^mcp\.([^.]+)\./);
    const id = mcp ? `mcp:${mcp[1]}` : (tool.id.split('.')[0] ?? 'iris');
    const label = mcp
      ? `MCP · ${mcp[1]}`
      : id === 'workspace'
        ? 'Workspace'
        : id === 'memory'
          ? 'Memory'
          : id === 'github'
            ? 'GitHub Operations'
            : id === 'web'
              ? 'Web & Search'
              : id === 'image'
                ? 'Image Generation'
                : id === 'browser'
                  ? 'Browser Automation'
                  : id === 'janitor'
                    ? 'Janitor Host Control'
                    : 'IRIS Core';
    const group = groups.get(id) ?? {
      id,
      label,
      description: mcp
        ? 'Tools advertised by this connected MCP server.'
        : id === 'web'
          ? 'Web search and full-page Firecrawl extraction tools.'
          : id === 'image'
            ? 'Multimodal image generation and synthesis tools.'
            : id === 'browser'
              ? 'Web page fetching and HTML structure inspection primitives.'
              : id === 'github'
                ? 'GitHub release management and issue triage tools.'
                : 'Built-in IRIS tools.',
      items: [],
    };
    group.items.push({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      meta: String(tool.risk ?? ''),
    });
    groups.set(id, group);
  }
  return [...groups.values()];
}

function skillGroups(skills: readonly SkillDefinition[]): CapabilityGroup[] {
  return ['local', 'imported'].flatMap((kind) => {
    const matches = skills.filter((skill) => skillOrigin(skill).kind === kind);
    return matches.length
      ? [
          {
            id: `skills:${kind}`,
            label: kind === 'local' ? 'Local skills' : 'Imported skills',
            description:
              kind === 'local'
                ? 'Skills authored in IRIS.'
                : 'Skills with recorded external provenance.',
            items: matches.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.summary || 'No summary.',
              meta: skill.enabled ? 'enabled' : 'disabled',
            })),
          },
        ]
      : [];
  });
}

function CapabilityPicker({
  title,
  groups,
  selectedIds,
  onToggle,
  onGroupAuthority,
  onClose,
}: {
  title: string;
  groups: CapabilityGroup[];
  selectedIds: readonly string[];
  onToggle: (id: string, selected: boolean) => void;
  onGroupAuthority?: (
    group: CapabilityGroup,
    policy: 'ask' | 'allow-read' | 'allow-all' | 'deny',
  ) => void;
  onClose: () => void;
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="capability-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="capability-picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="capability-picker-heading">
          <div>
            <p className="eyebrow">Agent capabilities</p>
            <h3>{title}</h3>
          </div>
          <button className="row-button" onClick={onClose}>
            Done
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="agent-note">Nothing is available yet.</p>
        ) : (
          groups.map((group) => {
            const allSelected = group.items.every((item) => selected.has(item.id));
            return (
              <section className="capability-group" key={group.id}>
                <div className="capability-group-heading">
                  <div>
                    <strong>{group.label}</strong>
                    <small>{group.description}</small>
                  </div>
                  <div className="capability-group-actions">
                    <button
                      className="row-button"
                      onClick={() => group.items.forEach((item) => onToggle(item.id, !allSelected))}
                    >
                      {allSelected ? 'Clear all' : 'Select all'}
                    </button>
                    {onGroupAuthority && (
                      <select
                        aria-label={`${group.label} authority`}
                        defaultValue="ask"
                        onChange={(event) =>
                          onGroupAuthority(
                            group,
                            event.target.value as 'ask' | 'allow-read' | 'allow-all' | 'deny',
                          )
                        }
                      >
                        <option value="ask">Ask</option>
                        <option value="allow-read">Allow read</option>
                        <option value="allow-all">Allow read + write</option>
                        <option value="deny">Deny</option>
                      </select>
                    )}
                  </div>
                </div>
                <div className="capability-group-items">
                  {group.items.map((item) => (
                    <label className="capability-item" key={item.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={(event) => onToggle(item.id, event.target.checked)}
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                      <em>{item.meta}</em>
                    </label>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </section>
    </div>
  );
}

function describeCortexTurn(turn: CortexTurnRecord): string {
  if (turn.status === 'running') return 'Provider execution is currently in progress.';
  if (turn.status === 'completed') {
    return 'The assistant response completed and was saved to the conversation.';
  }
  if (turn.status === 'failed') return `The turn failed: ${turn.failure.message}`;
  return `${turn.suspension.toolName} is paused for explicit approval. ${turn.suspension.reason}`;
}

/** Wall time between a step's request and its last recorded update. Empty when either timestamp
 * is missing or malformed — never a guessed duration. */
function formatStepDuration(step: CortexTurnStep): string {
  const started = new Date(step.startedAt).getTime();
  const updated = new Date(step.updatedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started) return '';
  const ms = updated - started;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function describeTurnStepStatus(step: CortexTurnStep): string {
  if (step.status === 'running') return 'Running';
  if (step.status === 'awaiting-approval') return 'Awaiting approval';
  if (step.status === 'completed') return 'Completed';
  if (step.status === 'denied') return 'Denied';
  return 'Failed';
}

function describeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

function TurnStepRow({ step }: { step: CortexTurnStep }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatStepDuration(step);
  return (
    <article className={`turn-step turn-step-${step.status}`}>
      <button
        type="button"
        className="turn-step-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="turn-step-name">{shortToolLabel({ name: step.toolName })}</span>
        <span className="turn-step-status">{describeTurnStepStatus(step)}</span>
        {duration && <span className="turn-step-duration">{duration}</span>}
      </button>
      {expanded && (
        <div className="turn-step-detail">
          <div>
            <span>Request</span>
            <ToolRequestView input={step.input} output={step.output} />
          </div>
          {step.status === 'completed' && step.toolName !== 'cortex_delegate_subagent' && (
            <p>
              <span>Result</span>
              <pre>{describeToolOutput(step.output)}</pre>
            </p>
          )}
          {(step.status === 'denied' || step.status === 'failed') && step.reason && (
            <p>
              <span>{step.status === 'denied' ? 'Denied' : 'Failed'}</span>
              <pre>{step.reason}</pre>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function AgentsState() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [providers, setProviders] = useState(() =>
    loadProviderConfigs().filter((provider) => provider.enabled && provider.model.trim()),
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [persona, setPersona] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [model, setModel] = useState(providers[0]?.model ?? '');
  const [takeoverProviderId, setTakeoverProviderId] = useState('');
  const [takeoverModel, setTakeoverModel] = useState('');
  const [autonomy, setAutonomy] = useState<AgentAutonomy>('assist');
  const [memoryAccess, setMemoryAccess] = useState<AgentMemoryAccess>('none');
  const [approvalMode, setApprovalMode] = useState<AgentApprovalMode>('ask');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('none');
  const [editorToolIds, setEditorToolIds] = useState<string[]>([]);
  const [editorToolPolicies, setEditorToolPolicies] = useState<AgentToolPolicies>({});
  const [availableSkills, setAvailableSkills] = useState<SkillDefinition[]>([]);
  const [editorSkillIds, setEditorSkillIds] = useState<string[]>([]);
  const [capabilityPopup, setCapabilityPopup] = useState<'tools' | 'skills' | null>(null);
  const [availableAgentTools, setAvailableAgentTools] = useState(() => toolRegistry.list());
  const [editorError, setEditorError] = useState('');
  const [draftMessage, setDraftMessage] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [contextPacks, setContextPacks] = useState<ContextPack[]>([]);
  const [cortexTurns, setCortexTurns] = useState<CortexTurnRecord[]>([]);
  const [turnSteps, setTurnSteps] = useState<CortexTurnStep[]>([]);
  const [selectedContextTurnId, setSelectedContextTurnId] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const contextInspectorRef = useRef<HTMLElement | null>(null);
  const conversationBodyRef = useRef<HTMLDivElement | null>(null);
  const reasoningTextRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(
    () =>
      subscribeProviderConfigs(() => {
        setProviders(
          loadProviderConfigs().filter((provider) => provider.enabled && provider.model.trim()),
        );
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    const load = () =>
      void listSkills().then((skills) => {
        if (active) setAvailableSkills(skills);
      });
    load();
    const unsubscribe = subscribeSkills(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => subscribeMcpServers(() => setAvailableAgentTools(toolRegistry.list())), []);
  const [assistantDraft, setAssistantDraft] = useState('');
  const [reasoningDraft, setReasoningDraft] = useState('');
  const [showReasoning, setShowReasoning] = useState(true);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [toolStatus, setToolStatus] = useState('');
  const [pendingApproval, setPendingApproval] = useState<AgentToolApproval | null>(null);
  const [pendingToolInput, setPendingToolInput] = useState<unknown>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (turnStartedAt === null) return;
    const tick = () => setElapsedSeconds(Math.round((Date.now() - turnStartedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [turnStartedAt]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providerId, providers],
  );
  const selectableModels = useMemo(
    () =>
      selectedProvider
        ? [...new Set([...selectableAgentModels(selectedProvider), model.trim()].filter(Boolean))]
        : [],
    [model, selectedProvider],
  );

  const selectedTakeoverProvider = useMemo(
    () => providers.find((provider) => provider.id === takeoverProviderId),
    [takeoverProviderId, providers],
  );
  const selectableTakeoverModels = useMemo(
    () =>
      selectedTakeoverProvider
        ? [...new Set([...selectableAgentModels(selectedTakeoverProvider), takeoverModel.trim()].filter(Boolean))]
        : [],
    [takeoverModel, selectedTakeoverProvider],
  );

  const missingEditorSkillIds = useMemo(
    () =>
      editorSkillIds.filter((skillId) => !availableSkills.some((skill) => skill.id === skillId)),
    [availableSkills, editorSkillIds],
  );

  useEffect(() => {
    if (selectedProvider && !model.trim()) setModel(selectedProvider.model);
  }, [model, selectedProvider]);

  useEffect(() => {
    let active = true;
    void Promise.all([agentRepository.list(), permissionRuleRepository.list()]).then(
      async ([storedAgents, storedRules]) => {
        const normalized = await Promise.all(storedAgents.map(normalizeDesktopAgent));
        const createdRules = await ensureAssignedToolsRequireApproval(
          permissionRuleRepository,
          normalized,
          availableAgentTools,
          storedRules,
        );
        if (createdRules > 0 && normalized[0]) {
          agentRuntime.refreshConfiguration(normalized[0].id);
        }
        if (!active) return;
        setAgents(normalized);
        setSelectedAgentId(normalized[0]?.id ?? null);
        setShowEditor(normalized.length === 0);
        setLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setAssistantDraft('');
    setToolStatus('');
    setPendingApproval(null);
    setPendingToolInput(null);
    setShowContext(false);
    setHistoryLoaded(false);
    if (!selectedAgentId) {
      setMessages([]);
      setContextPacks([]);
      setCortexTurns([]);
      setTurnSteps([]);
      setSelectedContextTurnId(null);
      setHistoryLoaded(true);
      return;
    }
    let active = true;
    const loadRuntimeState = async () => {
      const [history, suspended, storedContextPacks, storedCortexTurns, storedTurnSteps, storedAgents] =
        await Promise.all([
          conversationRepository.list(selectedAgentId),
          agentRuntime.suspendedForAgent(selectedAgentId),
          contextPackRepository.list(selectedAgentId),
          agentRuntime.cortexTurnsForAgent(selectedAgentId),
          cortexTurnStepRepository.listForAgent(selectedAgentId),
          agentRepository.list(),
        ]);
      if (!active) return;
      setAgents(storedAgents);
      setMessages(history);
      setContextPacks(storedContextPacks);
      setCortexTurns(storedCortexTurns);
      setTurnSteps(storedTurnSteps);
      setSelectedContextTurnId((current) =>
        storedContextPacks.some((pack) => pack.turnId === current)
          ? current
          : (storedContextPacks[0]?.turnId ?? null),
      );
      setAssistantDraft(suspended?.pending.assistantText ?? '');
      setPendingApproval(suspended?.pending.approval ?? null);
      setPendingToolInput(suspended?.pending.call.input ?? null);
      setToolStatus(
        suspended
          ? `${suspended.pending.approval.toolName} needs your approval before it can run.`
          : '',
      );
      setHistoryLoaded(true);
    };
    void loadRuntimeState();
    const unsubscribe = subscribeAgentRuntime((agentId) => {
      if (agentId === selectedAgentId) void loadRuntimeState();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedAgentId]);

  useEffect(() => {
    if (!showContext) return;
    const node = contextInspectorRef.current;
    const container = node?.closest('.conversation-body');
    if (!node || !(container instanceof HTMLElement)) return;
    // Scroll only the local conversation scrollport into view. A plain scrollIntoView() can walk
    // past this container to an ancestor the timeline now overflows, shifting the whole desktop.
    const nodeRect = node.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const overflowsTop = nodeRect.top - containerRect.top;
    const overflowsBottom = nodeRect.bottom - containerRect.bottom;
    if (overflowsTop < 0) container.scrollTop += overflowsTop;
    else if (overflowsBottom > 0) container.scrollTop += overflowsBottom;
  }, [selectedContextTurnId, showContext]);

  useEffect(() => {
    const body = conversationBodyRef.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
  }, [messages, pendingApproval, assistantDraft, reasoningDraft, toolStatus]);

  // The reasoning box scrolls independently of the chat body (it has its own
  // max-height/overflow), so it needs its own follow-the-tail effect.
  useEffect(() => {
    const node = reasoningTextRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [reasoningDraft]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const editingAgent = agents.find((agent) => agent.id === editingAgentId) ?? null;
  const selectedContextPack =
    contextPacks.find((pack) => pack.turnId === selectedContextTurnId) ?? contextPacks[0] ?? null;
  const selectedCortexTurn = selectedContextPack
    ? (cortexTurns.find((turn) => turn.turnId === selectedContextPack.turnId) ?? null)
    : null;
  const selectedTurnSteps = selectedContextPack
    ? turnSteps
        .filter((step) => step.turnId === selectedContextPack.turnId)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    : [];

  function selectAgent(agent: AgentDefinition) {
    setSelectedAgentId(agent.id);
    setShowEditor(false);
    setEditingAgentId(null);
    setEditorError('');
    setError('');
  }

  function beginNewAgent() {
    setEditingAgentId(null);
    setName('');
    setDescription('');
    setPersona('');
    setProviderId(providers[0]?.id ?? '');
    setModel(providers[0]?.model ?? '');
    setTakeoverProviderId('');
    setTakeoverModel('');
    setAutonomy('assist');
    setMemoryAccess('none');
    setApprovalMode('ask');
    setReasoningEffort('none');
    setEditorToolIds([]);
    setEditorToolPolicies({});
    setEditorSkillIds([]);
    setEditorError('');
    setShowEditor(true);
  }

  async function beginEditAgent(agent: AgentDefinition) {
    setEditingAgentId(agent.id);
    setName(agent.name);
    setDescription(agent.description ?? '');
    setPersona(agent.persona ?? '');
    setProviderId(agent.providerPolicyId ?? '');
    setModel(agent.model ?? '');
    setTakeoverProviderId(agent.takeoverProviderPolicyId ?? '');
    setTakeoverModel(agent.takeoverModel ?? '');
    setAutonomy(agent.autonomy);
    setMemoryAccess(agent.memoryAccess ?? 'none');
    setApprovalMode(agent.approvalMode ?? 'ask');
    setReasoningEffort(agent.reasoningEffort ?? 'none');
    setEditorToolIds([...agent.toolIds]);
    setEditorSkillIds([...agent.skillIds]);
    setEditorToolPolicies(
      editableAgentToolPolicies(agent, availableAgentTools, await permissionRuleRepository.list()),
    );
    setEditorError('');
    setShowEditor(true);
  }

  function toggleEditorSkill(skillId: string, assigned: boolean) {
    setEditorSkillIds((current) => {
      const next = new Set(current);
      if (assigned) next.add(skillId);
      else next.delete(skillId);
      return [...next];
    });
  }

  function toggleEditorTool(toolId: string, assigned: boolean) {
    setEditorToolIds((current) => {
      const next = new Set(current);
      if (assigned) next.add(toolId);
      else next.delete(toolId);
      return [...next];
    });
    setEditorToolPolicies((current) => ({
      ...current,
      [toolId]: assigned ? current[toolId] || 'ask' : '',
    }));
  }

  function setEditorToolPolicy(toolId: string, decision: PermissionDecision) {
    setEditorToolPolicies((current) => ({ ...current, [toolId]: decision }));
  }

  function setGroupAuthority(
    group: CapabilityGroup,
    policy: 'ask' | 'allow-read' | 'allow-all' | 'deny',
  ) {
    setEditorToolIds((current) => [
      ...new Set([...current, ...group.items.map((item) => item.id)]),
    ]);
    setEditorToolPolicies((current) => ({
      ...current,
      ...Object.fromEntries(
        group.items.map((item) => [
          item.id,
          policy === 'allow-read' && item.meta !== 'read'
            ? 'ask'
            : policy === 'allow-all'
              ? 'allow'
              : policy === 'deny'
                ? 'deny'
                : 'ask',
        ]),
      ),
    }));
  }

  async function saveAgentConfiguration() {
    const baseAgent: AgentDefinition = editingAgent ?? {
      id: `agent-${crypto.randomUUID()}`,
      name: '',
      autonomy: 'assist',
      memoryAccess: 'none',
      approvalMode: 'ask',
      skillIds: [],
      toolIds: [],
    };
    try {
      const agent = applyAgentConfiguration(baseAgent, {
        name,
        description,
        persona,
        providerPolicyId: providerId,
        model,
        takeoverProviderPolicyId: takeoverProviderId,
        takeoverModel,
        autonomy,
        memoryAccess,
        approvalMode,
        reasoningEffort,
        skillIds: editorSkillIds.filter((skillId) => !missingEditorSkillIds.includes(skillId)),
        toolIds: editorToolIds,
      });
      await agentRepository.save(agent);
      await saveAgentToolPolicies(
        permissionRuleRepository,
        agent,
        availableAgentTools,
        editorToolPolicies,
      );
      setAgents((current) => [...current.filter((item) => item.id !== agent.id), agent]);
      setSelectedAgentId(agent.id);
      setShowEditor(false);
      setEditingAgentId(null);
      setEditorError('');
      setError('');
      agentRuntime.refreshConfiguration(agent.id);
    } catch (configurationError) {
      setEditorError(
        configurationError instanceof Error
          ? configurationError.message
          : 'IRIS could not save the agent configuration.',
      );
    }
  }

  async function attachFiles(files: FileList) {
    const read = await Promise.all([...files].map(readAttachmentFile));
    setAttachments((current) => [...current, ...read]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const usableAttachments = attachments.filter((attachment) => !attachment.error);
    const images: ModelImage[] = usableAttachments
      .filter((attachment) => attachment.kind === 'image' && attachment.base64Data)
      .map((attachment) => ({ mimeType: attachment.mimeType, data: attachment.base64Data! }));
    const attachedText = usableAttachments
      .filter((attachment) => attachment.kind === 'text' && attachment.textContent)
      .map((attachment) => attachment.textContent)
      .join('\n\n');
    const content = [draftMessage.trim(), attachedText].filter(Boolean).join('\n\n');
    if ((!content && !images.length) || !selectedAgent || busy) return;
    recordUserActivity();
    const providerConfig = providers.find(
      (provider) => provider.id === selectedAgent.providerPolicyId,
    );
    if (!providerConfig) {
      setError('Choose a model provider for this agent first.');
      return;
    }
    setError('');
    setDraftMessage('');
    setAttachments([]);
    setToolStatus('');
    setReasoningDraft('');
    setTurnStartedAt(Date.now());
    setPendingApproval(null);
    setPendingToolInput(null);
    setBusy(true);
    try {
      await consumeRuntimeEvents(
        agentRuntime.send(selectedAgent.id, content, undefined, images),
        selectedAgent.id,
      );
    } catch (runtimeError) {
      setError(
        runtimeError instanceof Error
          ? runtimeError.message
          : 'The agent could not complete the request.',
      );
      setAssistantDraft('');
      setTurnStartedAt(null);
    } finally {
      setBusy(false);
    }
  }

  async function consumeRuntimeEvents(events: AsyncIterable<AgentEvent>, agentId: string) {
    for await (const runtimeEvent of events) {
      if (runtimeEvent.type === 'context-pack-ready') {
        setContextPacks((current) =>
          [
            runtimeEvent.pack,
            ...current.filter(
              (pack) =>
                pack.id !== runtimeEvent.pack.id && pack.turnId !== runtimeEvent.pack.turnId,
            ),
          ].slice(0, 40),
        );
        setSelectedContextTurnId(runtimeEvent.pack.turnId);
      } else if (runtimeEvent.type === 'user-message') {
        const history = await conversationRepository.list(agentId);
        setMessages(history);
      } else if (runtimeEvent.type === 'reasoning-chunk') {
        setReasoningDraft((current) => current + runtimeEvent.text);
      } else if (runtimeEvent.type === 'assistant-chunk') {
        setAssistantDraft((current) => current + runtimeEvent.text);
      } else if (runtimeEvent.type === 'assistant-complete') {
        const history = await conversationRepository.list(agentId);
        setMessages(history);
        setAssistantDraft('');
        setReasoningDraft('');
        setTurnStartedAt(null);
        setToolStatus('');
        setPendingApproval(null);
        setPendingToolInput(null);
      } else if (runtimeEvent.type === 'tool-call') {
        setToolStatus(`Requested ${runtimeEvent.call.name}. Checking authority…`);
      } else if (runtimeEvent.type === 'tool-complete') {
        setPendingApproval(null);
        setPendingToolInput(null);
        setToolStatus(`${runtimeEvent.call.name} completed. Continuing with the model…`);
      } else if (runtimeEvent.type === 'tool-denied') {
        setPendingApproval(null);
        setPendingToolInput(null);
        setToolStatus(
          `${runtimeEvent.call.name} was denied: ${runtimeEvent.reason} Returning that decision to the model…`,
        );
      } else if (runtimeEvent.type === 'tool-failed') {
        setPendingApproval(null);
        setPendingToolInput(null);
        setToolStatus(
          `${runtimeEvent.call.name} failed: ${runtimeEvent.reason} Returning that outcome to the model…`,
        );
      } else {
        setPendingApproval(runtimeEvent.approval);
        setPendingToolInput(runtimeEvent.call.input);
        setToolStatus(`${runtimeEvent.approval.toolName} needs your approval before it can run.`);
      }
    }
  }

  async function resolveAgentApproval(decision: 'approve' | 'deny') {
    if (!pendingApproval || !selectedAgent || busy) return;
    setBusy(true);
    setError('');
    setReasoningDraft('');
    setTurnStartedAt(Date.now());
    try {
      await consumeRuntimeEvents(
        agentRuntime.resolveApproval(pendingApproval.id, decision),
        selectedAgent.id,
      );
    } catch (runtimeError) {
      setError(
        runtimeError instanceof Error
          ? runtimeError.message
          : 'The tool approval could not be resolved.',
      );
      setTurnStartedAt(null);
    } finally {
      setBusy(false);
    }
  }

  async function clearConversation() {
    if (!selectedAgent) return;
    await agentRuntime.clearConversation(selectedAgent.id);
    setMessages([]);
    setContextPacks([]);
    setCortexTurns([]);
    setSelectedContextTurnId(null);
    setShowContext(false);
    setAssistantDraft('');
    setReasoningDraft('');
    setTurnStartedAt(null);
    setToolStatus('');
    setPendingApproval(null);
    setPendingToolInput(null);
    setAttachments([]);
    setError('');
  }

  return (
    <div className="agents-state">
      <div className="agents-heading">
        <div>
          <p className="eyebrow">Agent workspace</p>
          <h2>Build your own intelligence.</h2>
          <p>
            Agents are yours to configure. Their conversation stays inspectable and uses only the
            provider you choose.
          </p>
        </div>
        <button
          className="soft-button primary-button"
          disabled={busy || Boolean(pendingApproval)}
          onClick={beginNewAgent}
        >
          ＋ New agent
        </button>
      </div>
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
                    {takeoverProviderId ? 'Provider unavailable' : 'Choose a takeover provider first…'}
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
              Not every model or provider honors a reasoning-effort request; unsupported ones
              simply ignore it and answer as usual.
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
      {!loaded ? (
        <div className="agent-empty">
          <strong>Loading agents…</strong>
        </div>
      ) : agents.length === 0 ? (
        <div className="agent-empty">
          <strong>No agents yet</strong>
          <p>Create one above after connecting a model provider.</p>
        </div>
      ) : (
        <div className="agent-layout">
          <aside className="agent-list">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`agent-list-item ${selectedAgent?.id === agent.id ? 'selected' : ''}`}
                onClick={() => selectAgent(agent)}
              >
                <span className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>
                    {agent.autonomy} · {displayedAgentModel(agent, providers) ?? 'No provider'} ·
                    memory {agent.memoryAccess === 'read' ? 'read' : 'off'} ·{' '}
                    {agent.approvalMode === 'yolo' ? 'YOLO' : 'Ask'} · {agent.toolIds.length} tools
                  </small>
                </span>
              </button>
            ))}
          </aside>
          <section className="agent-conversation">
            <div className="conversation-header">
              <div>
                <p className="eyebrow">Live session</p>
                <h3>{selectedAgent?.name}</h3>
              </div>
              <div className="conversation-actions">
                {selectedAgent && (
                  <button
                    className="row-button"
                    disabled={busy || Boolean(pendingApproval)}
                    onClick={() => void beginEditAgent(selectedAgent)}
                  >
                    Edit agent
                  </button>
                )}
                {selectedContextPack && (
                  <button
                    className={`row-button context-toggle ${showContext ? 'active' : ''}`}
                    aria-expanded={showContext}
                    onClick={() => setShowContext((current) => !current)}
                  >
                    Context history · {contextPacks.length}
                  </button>
                )}
                {messages.length > 0 && (
                  <button className="row-button" disabled={busy} onClick={clearConversation}>
                    Clear
                  </button>
                )}
                <span className="truth-pill">
                  {pendingApproval ? 'Approval needed' : busy ? 'Working' : 'Ready'}
                </span>
              </div>
            </div>
            <div className="conversation-body" ref={conversationBodyRef}>
              {showContext && selectedContextPack && (
                <section
                  ref={contextInspectorRef}
                  className="context-inspector"
                  aria-label="Cortex context pack history"
                >
                  <div className="context-inspector-heading">
                    <div>
                      <p className="eyebrow">Cortex context</p>
                      <strong>Exact turn context · kept outside conversation history</strong>
                    </div>
                    <span>{formatMemoryDate(selectedContextPack.createdAt)}</span>
                  </div>
                  {contextPacks.length > 1 && (
                    <label className="context-history-picker">
                      <span>Inspect turn</span>
                      <select
                        value={selectedContextPack.turnId}
                        onChange={(event) => setSelectedContextTurnId(event.target.value)}
                      >
                        {contextPacks.map((pack, index) => (
                          <option key={pack.id} value={pack.turnId}>
                            {index === 0 ? 'Latest' : `Earlier ${index}`} · {pack.prompt}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="context-turn-reference">
                    <span>
                      {selectedContextPack.turnId.startsWith('legacy-context:')
                        ? 'Legacy pack · no durable answer link'
                        : 'Runtime turn'}
                    </span>
                    <code>{selectedContextPack.turnId}</code>
                  </div>
                  {selectedCortexTurn ? (
                    <div
                      className={`context-lifecycle context-lifecycle-${selectedCortexTurn.status}`}
                    >
                      <div className="context-lifecycle-heading">
                        <span>{selectedCortexTurn.status}</span>
                        <strong>
                          {selectedCortexTurn.providerId} · {selectedCortexTurn.model}
                        </strong>
                      </div>
                      <p>{describeCortexTurn(selectedCortexTurn)}</p>
                      <small>
                        Started {formatMemoryDate(selectedCortexTurn.startedAt)} · updated{' '}
                        {formatMemoryDate(selectedCortexTurn.updatedAt)}
                      </small>
                    </div>
                  ) : (
                    <div className="context-lifecycle context-lifecycle-unrecorded">
                      <div className="context-lifecycle-heading">
                        <span>Unrecorded</span>
                        <strong>Provider and outcome unavailable</strong>
                      </div>
                      <p>
                        This context predates durable Cortex turn lifecycle records. No runtime
                        outcome is inferred.
                      </p>
                    </div>
                  )}
                  {selectedCortexTurn?.status === 'completed' && selectedCortexTurn.usage && (
                    <p className="context-turn-usage">
                      {formatCount(selectedCortexTurn.usage.inputTokens)} in ·{' '}
                      {formatCount(selectedCortexTurn.usage.outputTokens)} out
                    </p>
                  )}
                  {selectedTurnSteps.length > 0 && (
                    <div className="context-timeline" aria-label="Tool call timeline">
                      <p className="context-timeline-heading">
                        Tool calls · {selectedTurnSteps.length}
                      </p>
                      {selectedTurnSteps.map((step) => (
                        <TurnStepRow key={`${step.turnId}:${step.toolCallId}`} step={step} />
                      ))}
                    </div>
                  )}
                  <p className="context-prompt">For "{selectedContextPack.prompt}"</p>
                  {selectedContextPack.sources.map((source) => (
                    <div
                      className={`context-source context-source-${source.state}`}
                      key={source.source}
                    >
                      <span>{source.source}</span>
                      <p>{source.detail}</p>
                    </div>
                  ))}
                  {selectedContextPack.selections.length > 0 && (
                    <div className="context-selections">
                      {selectedContextPack.selections.map((item) => (
                        <article
                          className={`context-selection-${item.source}`}
                          key={`${item.source}-${item.sourceId}`}
                        >
                          <div>
                            <code>{item.sourceId}</code>
                            <span>
                              {item.source === 'skill' ? 'Skill · ' : ''}
                              {formatMemoryDate(item.provenance.capturedAt)}
                            </span>
                          </div>
                          <p>{item.content}</p>
                          <small>{item.reason}</small>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {messages.length === 0 && !assistantDraft ? (
                <div className="conversation-empty">
                  <span>✦</span>
                  <p>Ask {selectedAgent?.name} something when you are ready.</p>
                </div>
              ) : (
                messages.map((message, index) => {
                  const linkedContext = message.turnId
                    ? contextPacks.find((pack) => pack.turnId === message.turnId)
                    : undefined;
                  return (
                    <div
                      className={`message message-${message.role}`}
                      key={`${message.role}-${message.turnId ?? index}`}
                    >
                      <MessageImages images={message.images} />
                      <RichMessage content={message.content} />
                      {message.role === 'assistant' && linkedContext && (
                        <button
                          className="message-context-link"
                          onClick={() => {
                            setSelectedContextTurnId(linkedContext.turnId);
                            setShowContext(true);
                          }}
                        >
                          Inspect context · {linkedContext.selections.length}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
              {reasoningDraft && (
                <div className={`desktop-chat-reasoning ${showReasoning ? 'expanded' : ''}`}>
                  <button
                    type="button"
                    className="desktop-chat-reasoning-toggle"
                    onClick={() => setShowReasoning((current) => !current)}
                    aria-expanded={showReasoning}
                  >
                    <span>Reasoning</span>
                    <span className="desktop-chat-reasoning-caret" aria-hidden="true">
                      {showReasoning ? '▾' : '▸'}
                    </span>
                  </button>
                  {showReasoning && (
                    <p className="desktop-chat-reasoning-text" ref={reasoningTextRef}>
                      {reasoningDraft}
                    </p>
                  )}
                </div>
              )}
              {assistantDraft && (
                <div className="message message-assistant">
                  <span>
                    {assistantDraft}
                    <i className="stream-cursor" />
                  </span>
                </div>
              )}
              {busy && !assistantDraft && turnStartedAt !== null && (
                <div className="desktop-chat-activity" role="status" aria-live="polite">
                  <span className="activity-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>Thinking…</span>
                  <span className="desktop-chat-elapsed">{formatElapsed(elapsedSeconds)}</span>
                </div>
              )}
              {error && (
                <div className="desktop-chat-turn-error" role="alert">
                  <span className="desktop-chat-turn-error-mark" aria-hidden="true">
                    !
                  </span>
                  <div>
                    <strong>IRIS stopped before finishing</strong>
                    <p>{error}</p>
                  </div>
                </div>
              )}
              {toolStatus && (
                <div className={`agent-tool-state ${pendingApproval ? 'approval-needed' : ''}`}>
                  <span className="agent-tool-mark" aria-hidden="true">
                    {pendingApproval ? '!' : '✓'}
                  </span>
                  <div>
                    <strong>{pendingApproval ? 'Permission required' : 'Tool activity'}</strong>
                    <p>{toolStatus}</p>
                    {pendingApproval && (
                      <div className="agent-tool-request">
                        <ToolRequestView input={pendingToolInput} />
                      </div>
                    )}
                  </div>
                  {pendingApproval && (
                    <span className="agent-tool-actions">
                      <button
                        className="row-button"
                        disabled={busy}
                        onClick={() => void resolveAgentApproval('deny')}
                      >
                        Deny
                      </button>
                      <button
                        className="row-button approval-button"
                        disabled={busy}
                        onClick={() => void resolveAgentApproval('approve')}
                      >
                        Approve & continue
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
            <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
            <form
              className="conversation-composer"
              onSubmit={sendMessage}
              {...composerDropHandlers((files) => void attachFiles(files))}
            >
              <AttachButton
                onFiles={(files) => void attachFiles(files)}
                disabled={busy || !historyLoaded || Boolean(pendingApproval)}
              />
              <input
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                disabled={busy || !historyLoaded || Boolean(pendingApproval)}
                placeholder={
                  !historyLoaded
                    ? 'Loading conversation…'
                    : pendingApproval
                      ? 'Resolve the tool request to continue…'
                      : busy
                        ? 'Agent is thinking…'
                        : 'Write a message…'
                }
                aria-label="Agent message"
              />
              <button
                className="soft-button primary-button"
                disabled={
                  busy ||
                  !historyLoaded ||
                  Boolean(pendingApproval) ||
                  (!draftMessage.trim() && !attachments.some((attachment) => !attachment.error))
                }
              >
                Send
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}