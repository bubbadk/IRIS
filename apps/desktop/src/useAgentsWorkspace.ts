import type {
  AgentApprovalMode,
  AgentAutonomy,
  AgentDefinition,
  AgentMemoryAccess,
  ReasoningEffort,
} from '@iris/core';
import { type ContextPack, type CortexTurnRecord, type CortexTurnStep } from '@iris/cortex';
import { loadProviderConfigs, subscribeProviderConfigs, type ModelImage } from '@iris/providers';
import { type SkillDefinition } from '@iris/skills';
import type { PermissionDecision } from '@iris/tools';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapabilityGroup } from './AgentCapabilities';
import { applyAgentConfiguration } from './agentConfiguration';
import { selectableAgentModels } from './agentModelSelection';
import {
  editableAgentToolPolicies,
  ensureAssignedToolsRequireApproval,
  saveAgentToolPolicies,
  type AgentToolPolicies,
} from './agentPermissions';
import { agentRuntime, normalizeDesktopAgent, subscribeAgentRuntime } from './agentRuntime';
import { readAttachmentFile, type ComposerAttachment } from './attachments';
import { subscribeMcpServers } from './mcp';
import {
  agentRepository,
  contextPackRepository,
  cortexTurnStepRepository,
  permissionRuleRepository,
} from './persistence';
import { listSkills, subscribeSkills } from './skills';
import { toolRegistry } from './tooling';
import { chatSessions, useChatSession } from './useChatSession';
import { recordUserActivity } from './userActivity';

export function useAgentsWorkspace() {
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
  const [showReasoning, setShowReasoning] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const {
    messages,
    assistantDraft,
    reasoningDraft,
    turnStartedAt,
    activity: toolStatus,
    approval: pendingApproval,
    approvalInput: pendingToolInput,
    busy,
    error,
    latestContextPack,
  } = useChatSession(selectedAgentId);
  useEffect(() => {
    if (!latestContextPack) return;
    setContextPacks((current) =>
      [
        latestContextPack,
        ...current.filter((pack) => pack.turnId !== latestContextPack.turnId),
      ].slice(0, 40),
    );
    setSelectedContextTurnId(latestContextPack.turnId);
  }, [latestContextPack]);

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
        ? [
            ...new Set(
              [...selectableAgentModels(selectedTakeoverProvider), takeoverModel.trim()].filter(
                Boolean,
              ),
            ),
          ]
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
    setShowContext(false);
    setHistoryLoaded(false);
    if (!selectedAgentId) {
      setContextPacks([]);
      setCortexTurns([]);
      setTurnSteps([]);
      setSelectedContextTurnId(null);
      setHistoryLoaded(true);
      return;
    }
    let active = true;
    const loadRuntimeState = async () => {
      const [storedContextPacks, storedCortexTurns, storedTurnSteps, storedAgents] =
        await Promise.all([
          contextPackRepository.list(selectedAgentId),
          agentRuntime.cortexTurnsForAgent(selectedAgentId),
          cortexTurnStepRepository.listForAgent(selectedAgentId),
          agentRepository.list(),
        ]);
      if (!active) return;
      setAgents(storedAgents);
      setContextPacks(storedContextPacks);
      setCortexTurns(storedCortexTurns);
      setTurnSteps(storedTurnSteps);
      setSelectedContextTurnId((current) =>
        storedContextPacks.some((pack) => pack.turnId === current)
          ? current
          : (storedContextPacks[0]?.turnId ?? null),
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
    setDraftMessage('');
    setAttachments([]);
    await chatSessions.send(selectedAgent.id, content, images);
  }

  async function resolveAgentApproval(decision: 'approve' | 'deny') {
    if (selectedAgentId) await chatSessions.resolve(selectedAgentId, decision);
  }

  async function clearConversation() {
    if (!selectedAgent || busy) return;
    await chatSessions.clear(selectedAgent.id);
    setContextPacks([]);
    setCortexTurns([]);
    setSelectedContextTurnId(null);
    setShowContext(false);
    setAttachments([]);
  }

  return {
    agents,
    setAgents,
    providers,
    setProviders,
    selectedAgentId,
    setSelectedAgentId,
    showEditor,
    setShowEditor,
    editingAgentId,
    setEditingAgentId,
    loaded,
    setLoaded,
    historyLoaded,
    setHistoryLoaded,
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
    setEditorToolIds,
    editorToolPolicies,
    setEditorToolPolicies,
    availableSkills,
    setAvailableSkills,
    editorSkillIds,
    setEditorSkillIds,
    capabilityPopup,
    setCapabilityPopup,
    availableAgentTools,
    setAvailableAgentTools,
    editorError,
    setEditorError,
    draftMessage,
    setDraftMessage,
    contextPacks,
    setContextPacks,
    cortexTurns,
    setCortexTurns,
    turnSteps,
    setTurnSteps,
    selectedContextTurnId,
    setSelectedContextTurnId,
    showContext,
    setShowContext,
    contextInspectorRef,
    conversationBodyRef,
    reasoningTextRef,
    showReasoning,
    setShowReasoning,
    elapsedSeconds,
    setElapsedSeconds,
    attachments,
    setAttachments,
    messages,
    assistantDraft,
    reasoningDraft,
    turnStartedAt,
    toolStatus,
    pendingApproval,
    pendingToolInput,
    busy,
    error,
    latestContextPack,
    selectedProvider,
    selectableModels,
    selectedTakeoverProvider,
    selectableTakeoverModels,
    missingEditorSkillIds,
    selectedAgent,
    editingAgent,
    selectedContextPack,
    selectedCortexTurn,
    selectedTurnSteps,
    selectAgent,
    beginNewAgent,
    beginEditAgent,
    toggleEditorSkill,
    toggleEditorTool,
    setEditorToolPolicy,
    setGroupAuthority,
    saveAgentConfiguration,
    attachFiles,
    removeAttachment,
    sendMessage,
    resolveAgentApproval,
    clearConversation,
  };
}
