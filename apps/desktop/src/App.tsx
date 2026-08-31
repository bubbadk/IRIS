import { useEffect, useMemo, useRef, useState } from 'react';
import { type AgentEvent, type AgentToolApproval, type ConversationMessage } from '@iris/agents';
import {
  resolveWorkspaceIntent,
  type ContextPack,
  type CortexTurnRecord,
  type CortexTurnStep,
} from '@iris/cortex';
import type {
  AgentApprovalMode,
  AgentAutonomy,
  AgentDefinition,
  AgentMemoryAccess,
  IrisObjectType,
  ReasoningEffort,
} from '@iris/core';
import type {
  MemoryEmbeddingIndexBuildProgress,
  MemoryEmbeddingIndexStatus,
  MemoryRecord,
} from '@iris/memory';
import { skillOrigin, type SkillDefinition } from '@iris/skills';
import { diffWorkspaceText, type WorkspaceMount } from '@iris/workspaces';
import type { PermissionDecision, ToolDefinition } from '@iris/tools';
import { DiffViewer } from './DiffViewer';
import { EmojiPicker, QuickReactionsBar } from './EmojiPicker';
import { ChannelsWindow } from './ChannelsState';
import { analyzeTurnForSkill, saveLearnedSkill, type LearnedSkillDraft } from './skillLearner';
import { OnboardingWizard, isOnboardingNeeded } from './OnboardingWizard';
import { checkLatestRelease, type ReleaseInfo } from './updateChecker';
import { UpdateNotificationModal } from './UpdateNotificationModal';
import {
  createProviderConfig,
  loadProviderCatalog,
  loadProviderConfigs,
  missingProviderConnectionFields,
  providerCatalogIdForConfig,
  providerConnectionFields,
  providerSupportsEmbeddings,
  refreshProviderCatalog,
  refreshProviderModels,
  saveProviderConfigs,
  subscribeProviderConfigs,
  testProviderConnection,
  validateProviderConfig,
  type ProviderCatalogEntry,
  type ModelImage,
  type ProviderCatalogId,
  type ProviderConfig,
} from '@iris/providers';
import { readAttachmentFile, type ComposerAttachment } from './attachments';
import {
  deleteProviderSecrets,
  isTauriRuntime,
  loadProviderSecrets,
  saveProviderSecrets,
} from './credentials';
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
  AgentsIcon,
  ChannelsIcon,
  CloseIcon,
  GitHubIcon,
  HomeIcon,
  IrisMark,
  MemoryIcon,
  ModelsIcon,
  ProjectsIcon,
  SchedulesIcon,
  SearchIcon,
  SettingsIcon,
  SystemIcon,
  ConnectionsIcon,
  SkillsIcon,
  WorkspaceIcon,
} from './icons';
import {
  defaultWindow,
  loadWindows,
  moveWindow,
  resizeWindow,
  saveWindows,
  windowLayerBase,
  type DesktopWindow,
} from './windowing';
import {
  agentRepository,
  contextPackRepository,
  conversationRepository,
  cortexTurnStepRepository,
  permissionRuleRepository,
  workspaceRepository,
} from './persistence';
import { formatCount } from './systemTelemetry';
import { PermissionsState } from './PermissionsState';
import { ProjectsState } from './ProjectsState';
import { SchedulesState } from './SchedulesState';
import { GitHubState } from './GitHubState';
import { SystemPanel } from './SystemPanel';
import { DesktopWidget } from './DesktopWidget';
import { McpState } from './McpState';
import { restoreMcpServers, subscribeMcpServers } from './mcp';
import { SkillsState } from './SkillsState';
import { listSkills, subscribeSkills } from './skills';
import { toolRegistry } from './tooling';
import { WorkspaceState } from './WorkspaceState';
import { startScheduledRuntime } from './scheduledRuntime';
import { subscribeWorkspace } from './workspace';
import { memoryService } from './memory';
import {
  onSudoPasswordRequestChange,
  resolveSudoPasswordRequest,
  type SudoPasswordRequest,
} from './sudoPasswordPrompt';
import {
  fetchEmbeddingModelOptions,
  getMemoryEmbeddingIndexStatus,
  loadMemoryRetrievalConfig,
  rebuildMemoryEmbeddingIndex,
  saveMemoryRetrievalConfig,
  testMemoryRetrievalConfig,
  validateMemoryRetrievalConfig,
  type MemoryRetrievalConfig,
} from './memoryRetrieval';

const objects: Array<{
  type: IrisObjectType;
  label: string;
  description: string;
  Icon: typeof AgentsIcon;
}> = [
  {
    type: 'agents',
    label: 'Agents',
    description: 'Create and configure autonomous workers.',
    Icon: AgentsIcon,
  },
  {
    type: 'projects',
    label: 'Projects',
    description: 'Shape durable task graphs and their prerequisites.',
    Icon: ProjectsIcon,
  },
  {
    type: 'schedules',
    label: 'Schedules',
    description: 'Plan agent runs with local, inspectable timing.',
    Icon: SchedulesIcon,
  },
  {
    type: 'workspace',
    label: 'Workspace',
    description: 'Mount and inspect one real local folder.',
    Icon: WorkspaceIcon,
  },
  {
    type: 'github',
    label: 'GitHub',
    description: 'Autonomous versioning, release automation & intelligent debugging.',
    Icon: GitHubIcon,
  },
  {
    type: 'models',
    label: 'Models',
    description: 'Connect local and cloud model providers.',
    Icon: ModelsIcon,
  },
  {
    type: 'memory',
    label: 'Memory',
    description: 'Inspect what the system remembers and why.',
    Icon: MemoryIcon,
  },
  {
    type: 'skills',
    label: 'Skills',
    description: 'Reusable capabilities and procedures.',
    Icon: SkillsIcon,
  },
  {
    type: 'connections',
    label: 'Connections',
    description: 'Connect MCP servers and inspect their real tools.',
    Icon: ConnectionsIcon,
  },
  {
    type: 'channels',
    label: 'Channels',
    description: 'Bridge Telegram and Discord messaging to IRIS.',
    Icon: ChannelsIcon,
  },
  {
    type: 'settings',
    label: 'System',
    description: 'Inspect tool authority and local permission decisions.',
    Icon: SystemIcon,
  },
];

void restoreMcpServers();

function EmptyState({ type }: { type: IrisObjectType }) {
  const item = objects.find((entry) => entry.type === type)!;
  const Icon = item.Icon;
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon />
      </div>
      <p className="eyebrow">{item.label}</p>
      <h2>{item.description}</h2>
      <p>
        This area is ready, but nothing has been configured yet. IRIS will show real state here once
        the corresponding runtime slice exists.
      </p>
      <div className="truth-pill">Not configured</div>
    </div>
  );
}

function WelcomeState() {
  return (
    <div className="empty-state welcome-state">
      <div className="empty-icon iris-empty">
        <IrisMark />
      </div>
      <p className="eyebrow">IRIS</p>
      <h2>Your intelligent workspace starts empty on purpose.</h2>
      <p>
        Open an object from the desktop or dock. As providers, agents and memory are added, this
        workspace becomes a live view of the real system rather than a simulated dashboard.
      </p>
    </div>
  );
}

function RichMessage({ content }: { content: string }) {
  const tokenPattern = /(https?:\/\/[^\s<]+|\*\*[^*]+\*\*)/g;
  return (
    <>
      {content.split(tokenPattern).map((token, index) => {
        if (/^https?:\/\//.test(token)) {
          const href = token.replace(/[),.;!?]+$/, '');
          const trailing = token.slice(href.length);
          const isImage =
            /\.(?:png|jpg|jpeg|webp|gif)(?:\?.*)?$/i.test(href) ||
            href.includes('pollinations.ai/prompt/') ||
            href.includes('oaidalleapiprodscus');
          if (isImage) {
            return (
              <span key={`${token}-${index}`} style={{ display: 'block', margin: '8px 0' }}>
                <a href={href} target="_blank" rel="noreferrer" style={{ display: 'inline-block' }}>
                  <img
                    src={href}
                    alt="Generated Visual"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '380px',
                      borderRadius: '10px',
                      boxShadow: '0 4px 14px rgba(0,0,0,0.1)',
                      border: '1px solid var(--line)',
                    }}
                  />
                </a>
                {trailing}
              </span>
            );
          }
          return (
            <span key={`${token}-${index}`}>
              <a href={href} target="_blank" rel="noreferrer">
                {href}
              </a>
              {trailing}
            </span>
          );
        }
        if (/^\*\*[^*]+\*\*$/.test(token))
          return <strong key={`${token}-${index}`}>{token.slice(2, -2)}</strong>;
        return <span key={`${token}-${index}`}>{token}</span>;
      })}
    </>
  );
}

function shortToolLabel(tool: { name: string; providerName?: string }): string {
  const raw = tool.providerName ?? tool.name;
  const withoutPrefix = raw.replace(/^mcp_(?:mcp_)?[0-9a-f-]{20,}_/i, '');
  return withoutPrefix.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface CapabilityGroup {
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
              ? 'Headless browser automation and inspection primitives.'
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

function SudoPasswordPromptModal({
  command,
  onSubmit,
  onCancel,
}: {
  command: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit() {
    if (!password) return;
    onSubmit(password);
    setPassword('');
  }

  return (
    <div
      className="capability-picker-backdrop"
      role="presentation"
      onMouseDown={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <section
        className="sudo-password-prompt"
        role="dialog"
        aria-modal="true"
        aria-label="Sudo password"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">Local command needs sudo</p>
        <h3>Enter your password</h3>
        <pre>{command}</pre>
        <p className="agent-note">
          IRIS needs your local sudo password to run this. It is used once, sent straight to
          the command, and never stored or logged.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            type="password"
            value={password}
            autoComplete="off"
            placeholder="Password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <div>
            <button type="button" className="row-button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="row-button approval-button" disabled={!password}>
              Run
            </button>
          </div>
        </form>
      </section>
    </div>
  );
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

/** "47s" under a minute, "3m 12s" at or beyond — short enough to sit next to the activity dots. */
function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

/** The "+" attach control: opens a small menu, currently just "Add files or photos". */
function AttachButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="attach-control">
      <button
        type="button"
        className="attach-button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-label="Add files or photos"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        +
      </button>
      {open && (
        <div className="attach-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              inputRef.current?.click();
            }}
          >
            <span className="attach-menu-icon" aria-hidden="true">
              📎
            </span>
            Add files or photos
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) onFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

/** The chip strip above a chat composer showing what will be sent, or why a file could not be. */
function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="attachment-chips">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={`attachment-chip ${attachment.error ? 'attachment-chip-error' : ''}`}
        >
          {attachment.kind === 'image' && attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" />
          ) : (
            <span className="attachment-chip-icon" aria-hidden="true">
              {attachment.error ? '!' : '📄'}
            </span>
          )}
          <span className="attachment-chip-name">{attachment.name}</span>
          <button
            type="button"
            className="attachment-chip-remove"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
          >
            ×
          </button>
          {attachment.error && <p className="attachment-chip-error-text">{attachment.error}</p>}
        </div>
      ))}
    </div>
  );
}

/** Thumbnails for the images attached to an already-sent message. */
function MessageImages({ images }: { images?: readonly ModelImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="message-images">
      {images.map((image, index) => (
        <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="Attached" />
      ))}
    </div>
  );
}

interface ActiveToolInvocation {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'completed' | 'denied' | 'failed';
  output?: unknown;
  reason?: string;
}

function SubAgentCardView({
  input,
  output,
  status,
}: {
  input: Record<string, unknown>;
  output?: unknown;
  status?: 'running' | 'completed' | 'denied' | 'failed';
}) {
  const role = typeof input.role === 'string' ? input.role : 'Specialist';
  const objective = typeof input.objective === 'string' ? input.objective : '';
  const instructions = typeof input.instructions === 'string' ? input.instructions : '';

  return (
    <div className={`subagent-card-view ${status ? `status-${status}` : ''}`}>
      <div className="subagent-card-header">
        <div className="subagent-card-title-group">
          <span className="subagent-card-role">Specialist · {role}</span>
          {status === 'running' && (
            <span className="subagent-status-badge running">
              <span className="activity-dots mini" aria-hidden="true">
                <i /><i /><i />
              </span>
              Working…
            </span>
          )}
          {status === 'completed' && (
            <span className="subagent-status-badge completed">Completed</span>
          )}
        </div>
        {typeof input.model === 'string' ? (
          <span className="subagent-card-model">{input.model}</span>
        ) : null}
      </div>
      <div className="subagent-card-objective">
        <strong>Objective:</strong> {objective}
      </div>
      {instructions ? (
        <details className="subagent-card-instructions">
          <summary>Instructions & Context</summary>
          <pre>{instructions}</pre>
        </details>
      ) : null}
      {output && typeof output === 'object' && 'output' in (output as Record<string, unknown>) ? (
        <div className="subagent-card-result">
          <strong>Findings & Report:</strong>
          <pre>{String((output as Record<string, unknown>).output)}</pre>
        </div>
      ) : null}
    </div>
  );
}

interface PerAgentChatState {
  messages: ConversationMessage[];
  assistantDraft: string;
  reasoningDraft: string;
  busy: boolean;
  activity: string;
  error: string;
  turnStartedAt: number | null;
  approval: AgentToolApproval | null;
  approvalInput: unknown;
  activeTools: ActiveToolInvocation[];
}

const defaultAgentState: PerAgentChatState = {
  messages: [],
  assistantDraft: '',
  reasoningDraft: '',
  busy: false,
  activity: '',
  error: '',
  turnStartedAt: null,
  approval: null,
  approvalInput: null,
  activeTools: [],
};

function ChatDesklet({
  onStarted,
  onReset,
  initialQuery,
}: {
  onStarted: () => void;
  onReset: () => void;
  initialQuery?: string;
}) {
  const [agents, setAgents] = useState<AgentDefinition[]>(() => agentRepository.listSync());
  const [selectedAgentId, setSelectedAgentId] = useState(
    () => agentRepository.listSync()[0]?.id || '',
  );
  const [agentStates, setAgentStates] = useState<Record<string, PerAgentChatState>>({});
  const [draft, setDraft] = useState(initialQuery ?? '');
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [tools, setTools] = useState(() => toolRegistry.list());
  const [showReasoning, setShowReasoning] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactions, setReactions] = useState<Record<string, Record<string, number>>>({});
  const abortControllersRef = useRef<Record<string, AbortController>>({});
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const reasoningTextRef = useRef<HTMLParagraphElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const currentAgentState = agentStates[selectedAgentId] ?? defaultAgentState;
  const {
    messages,
    assistantDraft,
    reasoningDraft,
    busy,
    activity,
    error,
    turnStartedAt,
    approval,
    approvalInput,
    activeTools,
  } = currentAgentState;

  const slashMode = draft.startsWith('/') && !draft.includes(' ');

  useEffect(() => {
    const focusComposer = () => {
      const el = textareaRef.current;
      if (el && !el.disabled) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    };

    focusComposer();
    const rAF = requestAnimationFrame(focusComposer);
    const timer = setTimeout(focusComposer, 50);
    return () => {
      cancelAnimationFrame(rAF);
      clearTimeout(timer);
    };
  }, [selectedAgent?.id, busy, Boolean(approval)]);

  async function attachFiles(files: FileList) {
    const read = await Promise.all([...files].map(readAttachmentFile));
    setAttachments((current) => [...current, ...read]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  useEffect(() => {
    if (turnStartedAt === null) return;
    const tick = () => setElapsedSeconds(Math.round((Date.now() - turnStartedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [turnStartedAt]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const stored = await agentRepository.list();
      const normalized = await Promise.all(stored.map(normalizeDesktopAgent));
      if (!active) return;
      setAgents(normalized);
      setSelectedAgentId((current) => current || normalized[0]?.id || '');
      setSkills(await listSkills());
    };
    void load();
    const unsubscribe = subscribeSkills(() => void listSkills().then(setSkills));
    const unsubscribeMcp = subscribeMcpServers(() => setTools(toolRegistry.list()));
    return () => {
      active = false;
      unsubscribe();
      unsubscribeMcp();
    };
  }, []);

  useEffect(() => {
    if (!selectedAgentId) return;
    let active = true;
    void Promise.all([
      conversationRepository.list(selectedAgentId),
      agentRuntime.suspendedForAgent(selectedAgentId),
    ]).then(([history, suspended]) => {
      if (!active) return;
      setAgentStates((prev) => {
        const cur = prev[selectedAgentId] ?? defaultAgentState;
        if (cur.busy) return prev;
        return {
          ...prev,
          [selectedAgentId]: {
            ...cur,
            messages: history,
            approval: suspended?.pending.approval ?? null,
            approvalInput: suspended?.pending.call.input ?? null,
            activity: suspended
              ? `Permission required for ${suspended.pending.approval.toolName}`
              : cur.activity,
          },
        };
      });
    });
    return () => {
      active = false;
    };
  }, [selectedAgentId]);

  useEffect(() => {
    const body = chatBodyRef.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
  }, [messages, approval, assistantDraft, reasoningDraft]);

  useEffect(() => {
    const node = reasoningTextRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [reasoningDraft]);

  function chooseSlashCommand(command: string) {
    setDraft(command.endsWith(' ') ? command : `${command} `);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const targetAgent = selectedAgent;
    if (!targetAgent) return;
    const targetAgentId = targetAgent.id;
    const targetState = agentStates[targetAgentId] ?? defaultAgentState;
    if (targetState.busy || targetState.approval) return;

    const usableAttachments = attachments.filter((attachment) => !attachment.error);
    const images: ModelImage[] = usableAttachments
      .filter((attachment) => attachment.kind === 'image' && attachment.base64Data)
      .map((attachment) => ({ mimeType: attachment.mimeType, data: attachment.base64Data! }));
    const attachedText = usableAttachments
      .filter((attachment) => attachment.kind === 'text' && attachment.textContent)
      .map((attachment) => attachment.textContent)
      .join('\n\n');
    const content = [draft.trim(), attachedText].filter(Boolean).join('\n\n');
    if (!content && !images.length) return;

    recordUserActivity();
    setDraft('');
    setAttachments([]);
    onStarted();

    const controller = new AbortController();
    abortControllersRef.current[targetAgentId] = controller;

    setAgentStates((prev) => ({
      ...prev,
      [targetAgentId]: {
        messages: prev[targetAgentId]?.messages ?? [],
        assistantDraft: '',
        reasoningDraft: '',
        error: '',
        activity: 'Thinking…',
        activeTools: [],
        turnStartedAt: Date.now(),
        busy: true,
        approval: null,
        approvalInput: null,
      },
    }));

    try {
      for await (const runtimeEvent of agentRuntime.send(
        targetAgentId,
        content,
        controller.signal,
        images,
      )) {
        if (runtimeEvent.type === 'user-message') {
          const history = await conversationRepository.list(targetAgentId);
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              messages: history,
            },
          }));
        } else if (runtimeEvent.type === 'reasoning-chunk') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              reasoningDraft: (prev[targetAgentId]?.reasoningDraft ?? '') + runtimeEvent.text,
            },
          }));
        } else if (runtimeEvent.type === 'assistant-chunk') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              assistantDraft: (prev[targetAgentId]?.assistantDraft ?? '') + runtimeEvent.text,
            },
          }));
        } else if (runtimeEvent.type === 'tool-call') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              activeTools: [
                ...(prev[targetAgentId]?.activeTools ?? []),
                {
                  id: runtimeEvent.call.id || Math.random().toString(),
                  name: runtimeEvent.call.name,
                  input: runtimeEvent.call.input,
                  status: 'running',
                },
              ],
              activity: `Running ${runtimeEvent.call.name.replaceAll('_', ' ')}…`,
            },
          }));
        } else if (runtimeEvent.type === 'tool-complete') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              activeTools: (prev[targetAgentId]?.activeTools ?? []).map((tool) =>
                tool.name === runtimeEvent.call.name && tool.status === 'running'
                  ? { ...tool, status: 'completed', output: runtimeEvent.output }
                  : tool,
              ),
              activity: 'Thinking…',
            },
          }));
        } else if (runtimeEvent.type === 'tool-denied') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              activeTools: (prev[targetAgentId]?.activeTools ?? []).map((tool) =>
                tool.name === runtimeEvent.call.name && tool.status === 'running'
                  ? { ...tool, status: 'denied', reason: runtimeEvent.reason }
                  : tool,
              ),
              activity: 'Thinking after tool result…',
            },
          }));
        } else if (runtimeEvent.type === 'tool-failed') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              activeTools: (prev[targetAgentId]?.activeTools ?? []).map((tool) =>
                tool.name === runtimeEvent.call.name && tool.status === 'running'
                  ? { ...tool, status: 'failed', reason: runtimeEvent.reason }
                  : tool,
              ),
              activity: 'Thinking after tool result…',
            },
          }));
        } else if (runtimeEvent.type === 'assistant-complete') {
          const list = await conversationRepository.list(targetAgentId);
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              messages: list,
              assistantDraft: '',
              reasoningDraft: '',
              activity: '',
              turnStartedAt: null,
            },
          }));
        } else if (runtimeEvent.type === 'tool-approval-required') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              approval: runtimeEvent.approval,
              approvalInput: runtimeEvent.call.input,
              activity: `Permission required for ${runtimeEvent.approval.toolName}`,
            },
          }));
        }
      }
    } catch (sendError) {
      if (controller.signal.aborted) {
        setAgentStates((prev) => ({
          ...prev,
          [targetAgentId]: {
            ...(prev[targetAgentId] ?? defaultAgentState),
            error: 'Turn stopped.',
            activity: '',
            turnStartedAt: null,
          },
        }));
        return;
      }
      setAgentStates((prev) => ({
        ...prev,
        [targetAgentId]: {
          ...(prev[targetAgentId] ?? defaultAgentState),
          error:
            sendError instanceof Error
              ? sendError.message
              : 'The agent could not complete the request.',
          activity: '',
          turnStartedAt: null,
        },
      }));
    } finally {
      delete abortControllersRef.current[targetAgentId];
      setAgentStates((prev) => ({
        ...prev,
        [targetAgentId]: {
          ...(prev[targetAgentId] ?? defaultAgentState),
          busy: false,
        },
      }));
    }
  }

  async function setChatReasoningEffort(agent: AgentDefinition, effort: ReasoningEffort) {
    const updated = { ...agent, reasoningEffort: effort === 'none' ? undefined : effort };
    await agentRepository.save(updated);
    setAgents((current) => current.map((item) => (item.id === agent.id ? updated : item)));
    try {
      agentRuntime.refreshConfiguration(agent.id);
      setAgentStates((prev) => ({
        ...prev,
        [agent.id]: {
          ...(prev[agent.id] ?? defaultAgentState),
          error: '',
        },
      }));
    } catch {
      // Configuration refresh is defensive
    }
  }

  async function clearChat() {
    if (!selectedAgent) return;
    const targetAgentId = selectedAgent.id;
    await conversationRepository.clear(targetAgentId);
    setAgentStates((prev) => ({
      ...prev,
      [targetAgentId]: {
        ...defaultAgentState,
      },
    }));
    setAttachments([]);
    setShowHistory(false);
    onReset();
  }

  async function resolveApproval(decision: 'approve' | 'deny') {
    const targetAgent = selectedAgent;
    if (!targetAgent) return;
    const targetAgentId = targetAgent.id;
    const targetState = agentStates[targetAgentId] ?? defaultAgentState;
    if (!targetState.approval) return;

    const controller = new AbortController();
    abortControllersRef.current[targetAgentId] = controller;

    setAgentStates((prev) => ({
      ...prev,
      [targetAgentId]: {
        ...(prev[targetAgentId] ?? defaultAgentState),
        busy: true,
        reasoningDraft: '',
        turnStartedAt: Date.now(),
      },
    }));

    try {
      for await (const runtimeEvent of agentRuntime.resolveApproval(
        targetState.approval.id,
        decision,
        controller.signal,
      )) {
        if (runtimeEvent.type === 'tool-call') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              activeTools: [
                ...(prev[targetAgentId]?.activeTools ?? []),
                {
                  id: runtimeEvent.call.id || Math.random().toString(),
                  name: runtimeEvent.call.name,
                  input: runtimeEvent.call.input,
                  status: 'running',
                },
              ],
              activity: `Running ${runtimeEvent.call.name.replaceAll('_', ' ')}…`,
            },
          }));
        } else if (runtimeEvent.type === 'tool-complete') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              activeTools: (prev[targetAgentId]?.activeTools ?? []).map((tool) =>
                tool.name === runtimeEvent.call.name && tool.status === 'running'
                  ? { ...tool, status: 'completed', output: runtimeEvent.output }
                  : tool,
            ),
            activity: 'Thinking…',
          },
        }));
        } else if (runtimeEvent.type === 'reasoning-chunk') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              reasoningDraft: (prev[targetAgentId]?.reasoningDraft ?? '') + runtimeEvent.text,
            },
          }));
        } else if (runtimeEvent.type === 'assistant-chunk') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              assistantDraft: (prev[targetAgentId]?.assistantDraft ?? '') + runtimeEvent.text,
            },
          }));
        } else if (runtimeEvent.type === 'assistant-complete') {
          const list = await conversationRepository.list(targetAgentId);
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              messages: list,
              assistantDraft: '',
              reasoningDraft: '',
              activity: '',
              turnStartedAt: null,
            },
          }));
        } else if (runtimeEvent.type === 'tool-approval-required') {
          setAgentStates((prev) => ({
            ...prev,
            [targetAgentId]: {
              ...(prev[targetAgentId] ?? defaultAgentState),
              approval: runtimeEvent.approval,
              approvalInput: runtimeEvent.call.input,
              activity: `Permission required for ${runtimeEvent.approval.toolName}`,
            },
          }));
        }
      }
      setAgentStates((prev) => ({
        ...prev,
        [targetAgentId]: {
          ...(prev[targetAgentId] ?? defaultAgentState),
          approval: null,
          approvalInput: null,
        },
      }));
    } catch (resolveError) {
      if (controller.signal.aborted) {
        setAgentStates((prev) => ({
          ...prev,
          [targetAgentId]: {
            ...(prev[targetAgentId] ?? defaultAgentState),
            error: 'Turn stopped.',
            activity: '',
            turnStartedAt: null,
            approval: null,
            approvalInput: null,
          },
        }));
        return;
      }
      setAgentStates((prev) => ({
        ...prev,
        [targetAgentId]: {
          ...(prev[targetAgentId] ?? defaultAgentState),
          error:
            resolveError instanceof Error
              ? resolveError.message
              : 'The approval could not be resolved.',
          activity: '',
          turnStartedAt: null,
        },
      }));
    } finally {
      delete abortControllersRef.current[targetAgentId];
      setAgentStates((prev) => ({
        ...prev,
        [targetAgentId]: {
          ...(prev[targetAgentId] ?? defaultAgentState),
          busy: false,
        },
      }));
    }
  }

  async function allowApprovalForAgent() {
    if (!approval || !selectedAgent) return;
    await permissionRuleRepository.save({
      id: `agent:${selectedAgent.id}:tool:${approval.toolId}`,
      agentId: selectedAgent.id,
      toolId: approval.toolId,
      decision: 'allow',
      reason: `The user explicitly allowed ${approval.toolName} for ${selectedAgent.name}.`,
    });
    await resolveApproval('approve');
  }

  async function stopTurn() {
    if (!selectedAgent) return;
    const targetAgentId = selectedAgent.id;
    const targetState = agentStates[targetAgentId] ?? defaultAgentState;
    if (targetState.approval && !targetState.busy) {
      await agentRuntime.cancelSuspended(targetAgentId);
      setAgentStates((prev) => ({
        ...prev,
        [targetAgentId]: {
          ...(prev[targetAgentId] ?? defaultAgentState),
          approval: null,
          approvalInput: null,
          activity: 'Turn stopped.',
          turnStartedAt: null,
        },
      }));
      return;
    }
    abortControllersRef.current[targetAgentId]?.abort();
  }

  const assignedSkills = selectedAgent
    ? skills.filter((skill) => selectedAgent.skillIds.includes(skill.id) && skill.enabled)
    : [];
  const assignedTools = selectedAgent
    ? tools.filter((tool) => selectedAgent.toolIds.includes(tool.id))
    : [];

  return (
    <section className="desktop-chat" aria-label="IRIS chat">
      <div className="desktop-chat-heading">
        <div>
          <p className="eyebrow">Live conversation</p>
          <strong>
            {selectedAgent ? `Talk to ${selectedAgent.name}` : 'Choose an agent to begin'}
          </strong>
        </div>
        <div className="desktop-chat-actions">
          <button
            type="button"
            className={`chat-header-button ${showHistory ? 'active' : ''}`}
            onClick={() => setShowHistory((current) => !current)}
            disabled={!selectedAgent}
          >
            History
          </button>
          <button
            type="button"
            className="chat-header-button"
            onClick={() => void clearChat()}
            disabled={!selectedAgent || busy || messages.length === 0}
          >
            Clear
          </button>
          <label className="desktop-agent-picker">
            <span>Agent</span>
            <select
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              <option value="">Choose agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} {agentStates[agent.id]?.busy ? '● (working)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="desktop-agent-picker" title="How hard the model should think before answering.">
            <span>Thinking</span>
            <select
              value={selectedAgent?.reasoningEffort ?? 'none'}
              onChange={(event) =>
                selectedAgent &&
                void setChatReasoningEffort(selectedAgent, event.target.value as ReasoningEffort)
              }
              disabled={!selectedAgent || busy}
            >
              <option value="none">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
      </div>
      {showHistory && (
        <div className="desktop-chat-history">
          <p className="eyebrow">Conversation history</p>
          <strong>
            {messages.length
              ? `${messages.length} messages saved for ${selectedAgent?.name}.`
              : 'No saved messages yet.'}
          </strong>
          <small>History is stored locally with this agent.</small>
        </div>
      )}
      <div className="desktop-chat-body" ref={chatBodyRef}>
        {messages.length === 0 && !assistantDraft && (
          <div className="desktop-chat-empty">
            <p className="eyebrow">{selectedAgent ? selectedAgent.name : 'IRIS agent'}</p>
            <strong>
              {selectedAgent
                ? selectedAgent.description || 'What would you like to achieve today?'
                : 'Choose an agent to start talking.'}
            </strong>
            {selectedAgent && (
              <div className="desktop-chat-empty-meta">
                <span>Model: {displayedAgentModel(selectedAgent, loadProviderConfigs())}</span>
                <span>{assignedSkills.length} skills</span>
                <span>{assignedTools.length} tools</span>
              </div>
            )}
          </div>
        )}
        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          const msgKey = `${message.turnId ?? index}-${message.role}`;
          const reactionKey = message.turnId || String(index);
          const msgReactions = reactions[reactionKey] || {};
          return (
            <div
              key={msgKey}
              className={`desktop-chat-message-row ${isUser ? 'user-row' : 'agent-row'}`}
            >
              <div className={`desktop-chat-message ${isUser ? 'user-message' : 'agent-message'}`}>
                {message.role === 'assistant' && (
                  <div className="message-header">
                    <span className="agent-tag">{selectedAgent?.name || 'IRIS'}</span>
                  </div>
                )}
                {message.images && message.images.length > 0 && (
                  <MessageImages images={message.images} />
                )}
                <div className="message-text">
                  <RichMessage content={message.content} />
                </div>
                {message.role === 'assistant' && (
                  <div className="message-footer">
                    <div className="reactions-container">
                      {['👍', '🔥', '💡', '❤️', '🤖'].map((emoji) => {
                        const count = msgReactions[emoji] || 0;
                        return (
                          <button
                            key={emoji}
                            className={`reaction-btn ${count > 0 ? 'reacted' : ''}`}
                            onClick={() => {
                              setReactions((prev) => {
                                const currentMsg = prev[reactionKey] || {};
                                const currentCount = currentMsg[emoji] || 0;
                                return {
                                  ...prev,
                                  [reactionKey]: {
                                    ...currentMsg,
                                    [emoji]: currentCount > 0 ? currentCount - 1 : currentCount + 1,
                                  },
                                };
                              });
                            }}
                          >
                            <span>{emoji}</span>
                            {count > 0 && <span className="count">{count}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {reasoningDraft && (
          <div className="desktop-chat-reasoning" role="status" aria-live="polite">
            <div className="desktop-chat-reasoning-head">
              <span className="desktop-chat-reasoning-eyebrow">Thinking</span>
              <button
                type="button"
                className="desktop-chat-reasoning-toggle"
                onClick={() => setShowReasoning((current) => !current)}
                aria-expanded={showReasoning}
              >
                {showReasoning ? 'Hide' : 'Show'}
              </button>
            </div>
            {showReasoning && (
              <p className="desktop-chat-reasoning-text" ref={reasoningTextRef}>
                {reasoningDraft}
              </p>
            )}
          </div>
        )}
        {assistantDraft && (
          <div className="desktop-chat-assistant-draft" role="status" aria-live="polite">
            <RichMessage content={assistantDraft} />
          </div>
        )}
        {activeTools.length > 0 && (
          <div className="desktop-chat-active-tools" aria-label="Running tools">
            {activeTools.map((tool) => (
              <div
                key={tool.id}
                className={`active-tool-item tool-${tool.status}`}
                title={tool.reason || (typeof tool.output === 'string' ? tool.output : undefined)}
              >
                <span className="tool-status-icon" aria-hidden="true">
                  {tool.status === 'running' && '⚡'}
                  {tool.status === 'completed' && '✓'}
                  {tool.status === 'failed' && '✕'}
                  {tool.status === 'denied' && '✋'}
                </span>
                <span className="tool-name">{tool.name.replaceAll('_', ' ')}</span>
                <span className="tool-badge">{tool.status}</span>
              </div>
            ))}
          </div>
        )}
        {approval && (
          <div className="desktop-chat-approval" role="alert">
            <p className="eyebrow">Permission requested</p>
            <strong>{approval.toolName} requires your approval</strong>
            <p>{approval.reason}</p>
            <ToolRequestView input={approvalInput} />
            <div>
              <button className="row-button" onClick={() => void resolveApproval('deny')}>
                Deny
              </button>
              <button className="row-button" onClick={() => void allowApprovalForAgent()}>
                Allow for this agent
              </button>
              <button
                className="row-button approval-button"
                onClick={() => void resolveApproval('approve')}
              >
                Approve & continue
              </button>
            </div>
          </div>
        )}
        {activity && (
          <div className="desktop-chat-activity" role="status" aria-live="polite">
            <span className="activity-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{activity}</span>
            {turnStartedAt !== null && (
              <span className="desktop-chat-elapsed">{formatElapsed(elapsedSeconds)}</span>
            )}
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
      </div>
      {slashMode && selectedAgent && (
        <div className="slash-palette" role="listbox" aria-label="Slash commands">
          <p>Skills</p>
          {assignedSkills.map((skill) => (
            <button key={skill.id} onClick={() => chooseSlashCommand(`/skill ${skill.name}`)}>
              /{skill.name}
            </button>
          ))}
          <p>MCP & tools</p>
          {assignedTools.map((tool) => (
            <button
              key={tool.id}
              onClick={() => chooseSlashCommand(`/mcp ${tool.providerName ?? tool.id}`)}
            >
              /mcp {shortToolLabel(tool)}
            </button>
          ))}
          {assignedSkills.length === 0 && assignedTools.length === 0 && (
            <small>No assigned skills or tools for this agent.</small>
          )}
        </div>
      )}
      <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
      <form className="desktop-chat-composer" onSubmit={send}>
        <AttachButton onFiles={(files) => void attachFiles(files)} disabled={!selectedAgent || busy} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            className="soft-button emoji-toggle-btn"
            title="Insert emoji"
            onClick={() => setShowEmojiPicker((v) => !v)}
            disabled={!selectedAgent || busy}
            style={{ fontSize: '15px', padding: '6px 9px' }}
          >
            😀
          </button>
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={(emoji) => {
                setDraft((prev) => prev + emoji);
                setShowEmojiPicker(false);
              }}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={!selectedAgent || busy || Boolean(approval)}
          placeholder={
            selectedAgent ? 'Write a message… Type / for skills and MCP tools' : 'Choose an agent…'
          }
          rows={3}
          aria-label="IRIS chat message"
        />
        {(busy || approval) && (
          <button
            type="button"
            className="soft-button stop-button"
            onClick={() => void stopTurn()}
            disabled={!selectedAgent}
          >
            Stop
          </button>
        )}
        <button
          className="soft-button primary-button"
          disabled={
            !selectedAgent ||
            busy ||
            Boolean(approval) ||
            (!draft.trim() && !attachments.some((attachment) => !attachment.error))
          }
        >
          Send
        </button>
      </form>
    </section>
  );
}

function AgentsState() {
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
                  <p className="context-prompt">For “{selectedContextPack.prompt}”</p>
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
                              {item.provenance.actorName} ·{' '}
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
            <form className="conversation-composer" onSubmit={sendMessage}>
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

function describeToolRequest(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return typeof input === 'string' ? input : (JSON.stringify(input) ?? String(input));
  }
  const value = input as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.path === 'string') lines.push(`Path · ${value.path}`);
  if (typeof value.sourcePath === 'string') lines.push(`Move from · ${value.sourcePath}`);
  if (typeof value.targetPath === 'string') lines.push(`Move to · ${value.targetPath}`);
  if (typeof value.overwrite === 'boolean') {
    lines.push(`Overwrite existing file · ${value.overwrite ? 'yes' : 'no'}`);
  }
  if (typeof value.content === 'string') {
    const preview = value.content.length > 280 ? `${value.content.slice(0, 280)}…` : value.content;
    lines.push(`Content · ${value.content.length} characters\n${preview}`);
  }
  if (typeof value.expectedContent === 'string' && typeof value.updatedContent === 'string') {
    const diff = diffWorkspaceText(value.expectedContent, value.updatedContent, 80);
    lines.push(
      `Patch preview · ${diff.changed ? 'changes requested' : 'no changes'}\n${diff.lines.map((line) => line.text).join('\n')}${diff.truncated ? '\n… preview truncated' : ''}`,
    );
  }
  const remaining = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          'path',
          'sourcePath',
          'targetPath',
          'overwrite',
          'content',
          'expectedContent',
          'updatedContent',
        ].includes(key),
    ),
  );
  if (Object.keys(remaining).length > 0) lines.push(JSON.stringify(remaining, null, 2));
  return lines.join('\n') || '{}';
}



function ToolRequestView({ input, output }: { input: unknown; output?: unknown }) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (typeof value.role === 'string' && typeof value.objective === 'string') {
      return <SubAgentCardView input={value} output={output} />;
    }
    if (typeof value.expectedContent === 'string' && typeof value.updatedContent === 'string') {
      const remaining = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'expectedContent' && key !== 'updatedContent'),
      );
      return (
        <div className="tool-request-view">
          {Object.keys(remaining).length > 0 ? (
            <pre>{describeToolRequest(remaining)}</pre>
          ) : null}
          <DiffViewer
            originalText={value.expectedContent}
            modifiedText={value.updatedContent}
            title={typeof value.path === 'string' ? `Patch · ${value.path}` : 'Patch Diff'}
          />
        </div>
      );
    }
  }
  return <pre>{describeToolRequest(input)}</pre>;
}

function describeCortexTurn(turn: CortexTurnRecord): string {
  if (turn.status === 'running') return 'Provider execution is currently in progress.';
  if (turn.status === 'completed') {
    return 'The assistant response completed and was saved to the conversation.';
  }
  if (turn.status === 'failed') return `The turn failed: ${turn.failure.message}`;
  return `${turn.suspension.toolName} is paused for explicit approval. ${turn.suspension.reason}`;
}

function formatMemoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
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

function MemoryState() {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [retrievalConfig, setRetrievalConfig] = useState<MemoryRetrievalConfig>(() =>
    loadMemoryRetrievalConfig(),
  );
  const [retrievalDraft, setRetrievalDraft] = useState<MemoryRetrievalConfig>(retrievalConfig);
  const [retrievalErrors, setRetrievalErrors] = useState<string[]>([]);
  const [retrievalState, setRetrievalState] = useState<
    'idle' | 'testing' | 'connected' | 'error' | 'saved'
  >('idle');
  const [embeddingIndexState, setEmbeddingIndexState] = useState<
    | MemoryEmbeddingIndexStatus
    | { state: 'checking' }
    | { state: 'rebuilding'; progress: MemoryEmbeddingIndexBuildProgress | null }
    | { state: 'error' }
    | null
  >(retrievalConfig.strategy === 'embedding' ? { state: 'checking' } : null);
  const [embeddingModels, setEmbeddingModels] = useState<string[]>([]);
  const [embeddingModelsState, setEmbeddingModelsState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const embeddingProviders = loadProviderConfigs().filter(
    (provider) => provider.enabled && providerSupportsEmbeddings(provider.kind),
  );

  useEffect(() => {
    let active = true;
    const loadMemory = () => memoryService.list();
    void Promise.all([loadMemory(), agentRepository.list()]).then(
      ([storedRecords, storedAgents]) => {
        if (!active) return;
        setRecords(storedRecords);
        setAgents(storedAgents);
        setSelectedId(storedRecords[0]?.id ?? null);
        setLoaded(true);
      },
    );
    const unsubscribe = subscribeAgentRuntime(() => {
      void loadMemory().then((storedRecords) => {
        if (!active) return;
        setRecords(storedRecords);
        setSelectedId((current) => current ?? storedRecords[0]?.id ?? null);
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (retrievalConfig.strategy === 'lexical') {
      setEmbeddingIndexState(null);
      return () => {
        active = false;
      };
    }
    setEmbeddingIndexState({ state: 'checking' });
    void getMemoryEmbeddingIndexStatus(retrievalConfig, records)
      .then((status) => {
        if (active) setEmbeddingIndexState(status);
      })
      .catch(() => {
        if (active) setEmbeddingIndexState({ state: 'error' });
      });
    return () => {
      active = false;
    };
  }, [records, retrievalConfig]);

  const draftEmbeddingProviderId =
    retrievalDraft.strategy === 'embedding' ? retrievalDraft.providerId : '';
  // One fetch per selected provider; loadEmbeddingModels only prefills an empty model field.
  useEffect(() => {
    if (draftEmbeddingProviderId) void loadEmbeddingModels(draftEmbeddingProviderId);
  }, [draftEmbeddingProviderId]);

  const selected = records.find((record) => record.id === selectedId) ?? null;
  const grantedAgents = agents.filter((agent) => agent.memoryAccess === 'read').length;

  function refreshMemoryReaders(): boolean {
    let deferred = false;
    for (const agent of agents) {
      if (agent.memoryAccess !== 'read') continue;
      try {
        agentRuntime.refreshConfiguration(agent.id);
      } catch {
        deferred = true;
      }
    }
    return deferred;
  }

  async function remember(event: React.FormEvent) {
    event.preventDefault();
    try {
      const record = await memoryService.remember(draft);
      setRecords((current) => [record, ...current]);
      setSelectedId(record.id);
      setDraft('');
      setError(
        refreshMemoryReaders()
          ? 'Memory was saved and will reach running agents after their current turn.'
          : '',
      );
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : 'IRIS could not save memory.');
    }
  }

  async function forget(record: MemoryRecord) {
    await memoryService.forget(record.id);
    const next = records.filter((item) => item.id !== record.id);
    setRecords(next);
    if (selectedId === record.id) setSelectedId(next[0]?.id ?? null);
    setError(
      refreshMemoryReaders()
        ? 'Memory was removed and running agents will refresh after their current turn.'
        : '',
    );
  }

  async function setAgentAccess(agent: AgentDefinition, memoryAccess: AgentMemoryAccess) {
    const updated = { ...agent, memoryAccess };
    await agentRepository.save(updated);
    setAgents((current) => current.map((item) => (item.id === agent.id ? updated : item)));
    try {
      agentRuntime.refreshConfiguration(agent.id);
      setError('');
    } catch {
      setError('Access was saved and will apply after the current agent run finishes.');
    }
  }

  async function loadEmbeddingModels(providerId: string) {
    if (!providerId) {
      setEmbeddingModels([]);
      setEmbeddingModelsState('idle');
      return;
    }
    setEmbeddingModelsState('loading');
    try {
      const models = await fetchEmbeddingModelOptions(providerId, embeddingProviders);
      setEmbeddingModels(models);
      setEmbeddingModelsState('ready');
      // The list is already filtered to embedding models, so prefill the first when empty.
      setRetrievalDraft((current) =>
        current.strategy === 'embedding' && !current.model.trim() && models[0]
          ? { ...current, model: models[0] }
          : current,
      );
    } catch {
      setEmbeddingModels([]);
      setEmbeddingModelsState('error');
    }
  }

  function selectRetrievalStrategy(strategy: MemoryRetrievalConfig['strategy']) {
    setRetrievalErrors([]);
    setRetrievalState('idle');
    if (strategy === 'lexical') {
      setRetrievalDraft({ strategy: 'lexical' });
      setEmbeddingModels([]);
      setEmbeddingModelsState('idle');
      return;
    }
    const providerId = embeddingProviders[0]?.id ?? '';
    setRetrievalDraft({ strategy: 'embedding', providerId, model: '' });
    void loadEmbeddingModels(providerId);
  }

  function selectEmbeddingProvider(providerId: string) {
    setRetrievalDraft((current) =>
      current.strategy === 'embedding' ? { ...current, providerId, model: '' } : current,
    );
    void loadEmbeddingModels(providerId);
  }

  async function saveRetrieval() {
    const nextErrors = validateMemoryRetrievalConfig(retrievalDraft, embeddingProviders);
    if (nextErrors.length) {
      setRetrievalErrors(nextErrors);
      setRetrievalState('error');
      return;
    }
    try {
      await saveMemoryRetrievalConfig(retrievalDraft);
      setRetrievalConfig(retrievalDraft);
      setRetrievalErrors([]);
      setRetrievalState('saved');
    } catch (saveError) {
      setRetrievalErrors([
        saveError instanceof Error ? saveError.message : 'IRIS could not save memory retrieval.',
      ]);
      setRetrievalState('error');
    }
  }

  async function testRetrieval() {
    setRetrievalErrors([]);
    setRetrievalState('testing');
    try {
      await testMemoryRetrievalConfig(retrievalDraft, embeddingProviders);
      setRetrievalState('connected');
    } catch (retrievalError) {
      setRetrievalErrors([
        retrievalError instanceof Error
          ? retrievalError.message
          : 'IRIS could not test embedding retrieval.',
      ]);
      setRetrievalState('error');
    }
  }

  async function rebuildEmbeddingIndex() {
    if (retrievalConfig.strategy !== 'embedding') return;
    setRetrievalErrors([]);
    setEmbeddingIndexState({ state: 'rebuilding', progress: null });
    try {
      const status = await rebuildMemoryEmbeddingIndex(
        retrievalConfig,
        records,
        embeddingProviders,
        undefined,
        undefined,
        (progress) => setEmbeddingIndexState({ state: 'rebuilding', progress }),
      );
      setEmbeddingIndexState(status);
    } catch (indexError) {
      setEmbeddingIndexState({ state: 'error' });
      setRetrievalErrors([
        indexError instanceof Error
          ? indexError.message
          : 'IRIS could not rebuild the local embedding index.',
      ]);
    }
  }

  const configuredEmbeddingProvider =
    retrievalConfig.strategy === 'embedding'
      ? embeddingProviders.find((provider) => provider.id === retrievalConfig.providerId)
      : undefined;
  const visibleIndexProgress =
    embeddingIndexState?.state === 'rebuilding'
      ? embeddingIndexState.progress
      : embeddingIndexState?.state === 'needs-rebuild'
        ? embeddingIndexState
        : null;

  return (
    <div className="memory-state">
      <div className="memory-heading">
        <div>
          <p className="eyebrow">Local memory</p>
          <h2>Remember with a clear source.</h2>
          <p>
            Saved records stay in this workspace. Agents see them only when you grant read access.
          </p>
        </div>
        <span className="memory-local-seal">Local store</span>
      </div>

      <div className="memory-facts">
        <div>
          <strong>{records.length}</strong>
          <span>saved records</span>
        </div>
        <div>
          <strong>{grantedAgents}</strong>
          <span>agents with access</span>
        </div>
      </div>

      <section className="memory-retrieval" aria-label="Memory retrieval">
        <div className="section-heading">
          <div>
            <h3>Retrieval</h3>
            <p>Choose how granted agents find records relevant to each prompt.</p>
          </div>
          <span>
            {retrievalConfig.strategy === 'lexical'
              ? 'Lexical active'
              : configuredEmbeddingProvider && embeddingIndexState?.state === 'ready'
                ? 'Index ready'
                : configuredEmbeddingProvider && embeddingIndexState?.state === 'rebuilding'
                  ? embeddingIndexState.progress
                    ? `${embeddingIndexState.progress.readyCount}/${embeddingIndexState.progress.recordCount} indexed`
                    : 'Preparing index'
                  : configuredEmbeddingProvider && embeddingIndexState?.state === 'checking'
                    ? 'Checking index'
                    : configuredEmbeddingProvider && embeddingIndexState?.state === 'error'
                      ? 'Index unavailable'
                      : configuredEmbeddingProvider
                        ? 'Rebuild needed'
                        : 'Needs configuration'}
          </span>
        </div>
        <div className="memory-retrieval-status">
          {retrievalConfig.strategy === 'lexical' ? (
            <p>
              Local embeddings are not configured. IRIS uses deterministic lexical ranking without a
              model or network connection.
            </p>
          ) : configuredEmbeddingProvider ? (
            embeddingIndexState?.state === 'ready' ? (
              <p>
                The persistent index contains <strong>{embeddingIndexState.recordCount}</strong>{' '}
                records for <strong>{retrievalConfig.model}</strong>. It was built{' '}
                <strong>{formatMemoryDate(embeddingIndexState.builtAt)}</strong>; recalls embed only
                the current prompt.
              </p>
            ) : embeddingIndexState?.state === 'rebuilding' ? (
              <p>
                IRIS is indexing through <strong>{configuredEmbeddingProvider.name}</strong>.{' '}
                {embeddingIndexState.progress ? (
                  <>
                    <strong>{embeddingIndexState.progress.readyCount}</strong> of{' '}
                    <strong>{embeddingIndexState.progress.recordCount}</strong> records are safely
                    checkpointed. Unchanged valid vectors are retained.
                  </>
                ) : (
                  'Existing checkpoints are being inspected before any embedding request is sent.'
                )}
              </p>
            ) : embeddingIndexState?.state === 'checking' ? (
              <p>Checking the persisted local index for this provider and model…</p>
            ) : embeddingIndexState?.state === 'error' ? (
              <p>
                The local index could not be inspected or rebuilt. See the reported error below.
              </p>
            ) : (
              <p>
                Semantic retrieval is configured for <strong>{retrievalConfig.model}</strong>.{' '}
                {embeddingIndexState?.reason === 'failed'
                  ? `${embeddingIndexState.failedCount} record${embeddingIndexState.failedCount === 1 ? '' : 's'} failed and can be retried; completed vectors remain checkpointed.`
                  : embeddingIndexState?.reason === 'records-changed'
                    ? `${embeddingIndexState.readyCount} unchanged vector${embeddingIndexState.readyCount === 1 ? '' : 's'} can be retained while changed records are indexed.`
                    : 'Its local index needs an explicit build.'}
              </p>
            )
          ) : (
            <p>
              The selected embedding provider is unavailable. Choose lexical retrieval or connect an
              enabled provider before the next agent recall.
            </p>
          )}
        </div>
        {configuredEmbeddingProvider &&
          visibleIndexProgress &&
          visibleIndexProgress.recordCount > 0 && (
            <div className="memory-index-progress" aria-live="polite">
              <div className="memory-index-progress-heading">
                <span>
                  <strong>{visibleIndexProgress.readyCount}</strong> ready ·{' '}
                  <strong>{visibleIndexProgress.pendingCount}</strong> pending ·{' '}
                  <strong>{visibleIndexProgress.failedCount}</strong> failed
                </span>
                {embeddingIndexState?.state === 'rebuilding' &&
                  embeddingIndexState.progress?.currentMemoryId && <span>Embedding now</span>}
              </div>
              <ol>
                {visibleIndexProgress.records.map((recordState) => {
                  const memoryRecord = records.find((record) => record.id === recordState.memoryId);
                  const isCurrent =
                    embeddingIndexState?.state === 'rebuilding' &&
                    embeddingIndexState.progress?.currentMemoryId === recordState.memoryId;
                  return (
                    <li
                      key={recordState.memoryId}
                      data-state={isCurrent ? 'active' : recordState.state}
                    >
                      <div>
                        <strong>{memoryRecord?.content ?? recordState.memoryId}</strong>
                        {recordState.state === 'failed' && (
                          <small>
                            {recordState.error} · attempt {recordState.attempts} ·{' '}
                            {formatMemoryDate(recordState.lastAttemptAt)}
                          </small>
                        )}
                      </div>
                      <span>{isCurrent ? 'Embedding' : recordState.state}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        <div className="memory-retrieval-editor">
          <label>
            Strategy
            <select
              value={retrievalDraft.strategy}
              onChange={(event) =>
                selectRetrievalStrategy(event.target.value as MemoryRetrievalConfig['strategy'])
              }
            >
              <option value="lexical">Deterministic lexical</option>
              <option value="embedding">Provider embeddings</option>
            </select>
          </label>
          {retrievalDraft.strategy === 'embedding' && (
            <>
              <label>
                Embedding provider
                <select
                  value={retrievalDraft.providerId}
                  onChange={(event) => selectEmbeddingProvider(event.target.value)}
                >
                  <option value="">Choose provider…</option>
                  {embeddingProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                      {provider.kind === 'ollama' ? ' (local)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="memory-model-label">
                  Embedding model
                  {retrievalDraft.providerId && (
                    <button
                      type="button"
                      className="memory-model-refresh"
                      disabled={embeddingModelsState === 'loading'}
                      onClick={() => void loadEmbeddingModels(retrievalDraft.providerId)}
                    >
                      {embeddingModelsState === 'loading'
                        ? 'Loading…'
                        : embeddingModelsState === 'error'
                          ? 'Retry'
                          : 'Refresh'}
                    </button>
                  )}
                </span>
                <input
                  value={retrievalDraft.model}
                  list="embedding-model-options"
                  onChange={(event) =>
                    setRetrievalDraft({ ...retrievalDraft, model: event.target.value })
                  }
                  placeholder={
                    embeddingModelsState === 'loading'
                      ? 'Loading models…'
                      : 'e.g. text-embedding-3-small or embeddinggemma'
                  }
                />
                <datalist id="embedding-model-options">
                  {embeddingModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                {embeddingModelsState === 'ready' && embeddingModels.length > 0 && (
                  <small className="memory-model-hint">
                    {embeddingModels.length} embedding{' '}
                    {embeddingModels.length === 1 ? 'model' : 'models'} found — start typing to
                    filter.
                  </small>
                )}
                {embeddingModelsState === 'ready' && embeddingModels.length === 0 && (
                  <small className="memory-model-hint">
                    No embedding models found for this provider — it may not offer embeddings. Type a
                    model name if you know one.
                  </small>
                )}
                {embeddingModelsState === 'error' && (
                  <small className="memory-model-hint">
                    IRIS could not list this provider&apos;s models. Enter the model name manually.
                  </small>
                )}
              </label>
            </>
          )}
        </div>
        {retrievalDraft.strategy === 'embedding' && embeddingProviders.length === 0 && (
          <div className="memory-retrieval-empty">
            No enabled provider supports embeddings yet. Add an OpenAI-compatible or Ollama provider
            in the Models object first.
          </div>
        )}
        {retrievalErrors.length > 0 && (
          <div className="form-errors">
            {retrievalErrors.map((retrievalError) => (
              <span key={retrievalError}>{retrievalError}</span>
            ))}
          </div>
        )}
        <div className="memory-retrieval-actions">
          {retrievalDraft.strategy === 'embedding' && (
            <button
              className="row-button"
              disabled={retrievalState === 'testing'}
              onClick={() => void testRetrieval()}
            >
              {retrievalState === 'testing'
                ? 'Testing…'
                : retrievalState === 'connected'
                  ? 'Test passed'
                  : 'Test embedding'}
            </button>
          )}
          {retrievalConfig.strategy === 'embedding' && configuredEmbeddingProvider && (
            <button
              className="row-button"
              disabled={embeddingIndexState?.state === 'rebuilding'}
              onClick={() => void rebuildEmbeddingIndex()}
            >
              {embeddingIndexState?.state === 'rebuilding'
                ? 'Rebuilding…'
                : embeddingIndexState?.state === 'ready'
                  ? 'Rebuild index'
                  : embeddingIndexState?.state === 'needs-rebuild' &&
                      embeddingIndexState.failedCount > 0
                    ? 'Retry index'
                    : 'Build index'}
            </button>
          )}
          <button className="soft-button primary-button" onClick={() => void saveRetrieval()}>
            {retrievalState === 'saved' ? 'Saved' : 'Save retrieval'}
          </button>
        </div>
      </section>

      <form className="memory-composer" onSubmit={remember}>
        <label htmlFor="memory-content">Add a workspace memory</label>
        <div>
          <textarea
            id="memory-content"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a fact or preference that should remain available…"
            rows={3}
          />
          <button className="soft-button primary-button" disabled={!draft.trim()}>
            Remember
          </button>
        </div>
        <small>
          Manual entries are immediate. Agents can write only through the separately assigned and
          permission-gated Memory tool.
        </small>
      </form>

      <section className="memory-access" aria-label="Agent memory access">
        <div className="section-heading">
          <h3>Agent access</h3>
          <span>Deny by default</span>
        </div>
        {agents.length === 0 ? (
          <div className="memory-access-empty">Create an agent before granting memory access.</div>
        ) : (
          <div className="memory-access-list">
            {agents.map((agent) => (
              <label key={agent.id}>
                <span className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>Applies to new and refreshed sessions</small>
                </span>
                <select
                  value={agent.memoryAccess ?? 'none'}
                  onChange={(event) =>
                    void setAgentAccess(agent, event.target.value as AgentMemoryAccess)
                  }
                >
                  <option value="none">No access</option>
                  <option value="read">Read</option>
                </select>
              </label>
            ))}
          </div>
        )}
      </section>

      {!loaded ? (
        <div className="memory-empty">Loading saved memory…</div>
      ) : records.length === 0 ? (
        <div className="memory-empty">
          <strong>No memories saved</strong>
          <p>Add a real record above. IRIS will not invent context to fill this space.</p>
        </div>
      ) : (
        <div className="memory-browser">
          <div className="memory-list" aria-label="Saved memories">
            {records.map((record) => (
              <button
                key={record.id}
                className={selected?.id === record.id ? 'selected' : ''}
                onClick={() => setSelectedId(record.id)}
              >
                <strong>{record.content}</strong>
                <small>{formatMemoryDate(record.createdAt)}</small>
              </button>
            ))}
          </div>
          {selected && (
            <article className="memory-detail">
              <div className="memory-detail-heading">
                <p className="eyebrow">Saved record</p>
                <button className="row-button danger-button" onClick={() => void forget(selected)}>
                  Forget
                </button>
              </div>
              <p className="memory-content">{selected.content}</p>
              <dl>
                <div>
                  <dt>Source</dt>
                  <dd>{selected.provenance.source === 'user' ? 'Manual entry' : 'Agent'}</dd>
                </div>
                <div>
                  <dt>Recorded by</dt>
                  <dd>{selected.provenance.actorName}</dd>
                </div>
                <div>
                  <dt>Captured</dt>
                  <dd>{formatMemoryDate(selected.provenance.capturedAt)}</dd>
                </div>
                {selected.provenance.source === 'agent' && (
                  <>
                    <div>
                      <dt>Originating turn</dt>
                      <dd>{selected.provenance.turnId}</dd>
                    </div>
                    <div>
                      <dt>Tool call</dt>
                      <dd>{selected.provenance.toolCallId}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Record ID</dt>
                  <dd>{selected.id}</dd>
                </div>
              </dl>
            </article>
          )}
        </div>
      )}
      {error && <p className="memory-error">{error}</p>}
    </div>
  );
}

function ModelsState() {
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviderConfigs());
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>(() => loadProviderCatalog());
  const [catalogSync, setCatalogSync] = useState<'syncing' | 'current' | 'offline'>('syncing');
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [catalogChoice, setCatalogChoice] = useState<ProviderCatalogId>('openai');
  const [saving, setSaving] = useState(false);
  const [activityStates, setActivityStates] = useState<
    Record<string, 'testing' | 'connected' | 'refreshing' | 'ready' | 'error'>
  >({});
  const [activityMessages, setActivityMessages] = useState<Record<string, string>>({});
  const desktopRuntime = isTauriRuntime();
  const selectedCatalogEntry =
    catalog.find((entry) => entry.id === catalogChoice) ?? catalog.find((entry) => entry.supported);
  const supportedCatalog = catalog.filter((entry) => entry.supported);
  const pendingCatalog = catalog.filter((entry) => !entry.supported);

  useEffect(() => saveProviderConfigs(providers), [providers]);

  useEffect(() => {
    let active = true;
    void refreshProviderCatalog()
      .then((next) => {
        if (!active) return;
        setCatalog(next);
        setCatalogSync('current');
      })
      .catch(() => {
        if (active) setCatalogSync('offline');
      });
    return () => {
      active = false;
    };
  }, []);

  function startAdding() {
    if (!selectedCatalogEntry?.supported) return;
    setErrors([]);
    setDraft(createProviderConfig(selectedCatalogEntry));
  }

  function catalogEntryForConfig(provider: ProviderConfig): ProviderCatalogEntry {
    const id = providerCatalogIdForConfig(provider);
    return (
      catalog.find((entry) => entry.id === id) ?? {
        id,
        name: provider.name,
        description: 'Saved provider configuration. The live directory is not available.',
        kind: provider.kind,
        endpoint: provider.endpoint,
        credentialMode:
          provider.credentialMode ?? (provider.kind === 'ollama' ? 'none' : 'optional'),
        credentialNames: [],
        connectionFields: providerConnectionFields(provider),
        supported: true,
        source: 'built-in',
      }
    );
  }

  function upsertProvider(provider: ProviderConfig) {
    setProviders((current) => {
      const exists = current.some((candidate) => candidate.id === provider.id);
      return exists
        ? current.map((candidate) => (candidate.id === provider.id ? provider : candidate))
        : [...current, provider];
    });
  }

  async function resolveProviderConnection(provider: ProviderConfig): Promise<ProviderConfig> {
    const hasSecretFields = providerConnectionFields(provider).some((field) => field.secret);
    const storedSecrets =
      hasSecretFields || provider.storedSecretFields?.length
        ? await loadProviderSecrets(provider.id)
        : null;
    return {
      ...provider,
      connectionValues: {
        ...(storedSecrets ?? {}),
        ...(provider.connectionValues ?? {}),
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      },
    };
  }

  async function saveDraft() {
    if (!draft) return;
    const nextErrors = validateProviderConfig(draft, {
      requireModel: draft.kind === 'azure-openai',
    });
    if (nextErrors.length) {
      setErrors(nextErrors);
      return;
    }
    setSaving(true);
    setErrors([]);
    const existing = providers.find((provider) => provider.id === draft.id);
    const secretFields = providerConnectionFields(draft).filter((field) => field.secret);
    const credentialChanged = secretFields.some((field) =>
      Boolean(draft.connectionValues?.[field.id]?.trim()),
    );
    let next: ProviderConfig = {
      ...draft,
      connectionValues: {
        ...(existing?.connectionValues ?? {}),
        ...(draft.connectionValues ?? {}),
      },
    };
    if (credentialChanged) {
      try {
        const resolved = await resolveProviderConnection(next);
        const secrets = Object.fromEntries(
          secretFields.flatMap((field) => {
            const value = resolved.connectionValues?.[field.id]?.trim();
            return value ? [[field.id, value]] : [];
          }),
        );
        const storedInOsKeyring = await saveProviderSecrets(next.id, secrets);
        next = {
          ...next,
          connectionValues: storedInOsKeyring
            ? Object.fromEntries(
                Object.entries(next.connectionValues ?? {}).filter(
                  ([fieldId]) => !secretFields.some((field) => field.id === fieldId),
                ),
              )
            : next.connectionValues,
          storedSecretFields: storedInOsKeyring
            ? Object.keys(secrets)
            : (next.storedSecretFields ?? []).filter(
                (fieldId) => !secretFields.some((field) => field.id === fieldId),
              ),
          availableModels: credentialChanged ? undefined : next.availableModels,
          modelsRefreshedAt: credentialChanged ? undefined : next.modelsRefreshedAt,
        };
      } catch {
        setErrors(['IRIS could not save this key in the OS credential store.']);
        setSaving(false);
        return;
      }
    }

    try {
      const connected = await resolveProviderConnection(next);
      const missingFields = missingProviderConnectionFields({
        ...connected,
        storedSecretFields: [],
      });
      if (missingFields.length) {
        throw new Error(
          `Add ${missingFields.map((field) => field.label.toLowerCase()).join(' and ')} before IRIS requests the provider model list.`,
        );
      }
      const refreshed = await refreshProviderModels(connected);
      next = {
        ...refreshed,
        connectionValues: next.connectionValues,
      };
      setActivityStates((current) => ({ ...current, [next.id]: 'ready' }));
      setActivityMessages((current) => ({
        ...current,
        [next.id]: `${next.availableModels?.length ?? 0} models refreshed`,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'IRIS could not refresh the provider model list.';
      setActivityStates((current) => ({ ...current, [next.id]: 'error' }));
      setActivityMessages((current) => ({ ...current, [next.id]: message }));
      if (!next.model.trim()) {
        upsertProvider(next);
        setDraft(next);
        setErrors([
          message,
          'The provider was saved, but it needs a model name before an agent can use it.',
        ]);
        setSaving(false);
        return;
      }
    }

    const finalErrors = validateProviderConfig(next);
    if (finalErrors.length) {
      setErrors(finalErrors);
      setSaving(false);
      return;
    }
    upsertProvider(next);
    setDraft(null);
    setErrors([]);
    setSaving(false);
  }

  async function testConnection(provider: ProviderConfig) {
    setActivityStates((current) => ({ ...current, [provider.id]: 'testing' }));
    setActivityMessages((current) => ({ ...current, [provider.id]: 'Testing connection…' }));
    try {
      const connected = await resolveProviderConnection(provider);
      const missingFields = missingProviderConnectionFields({
        ...connected,
        storedSecretFields: [],
      });
      if (missingFields.length) {
        throw new Error('Required provider credentials are not available.');
      }
      await testProviderConnection(connected);
      setActivityStates((current) => ({ ...current, [provider.id]: 'connected' }));
      setActivityMessages((current) => ({ ...current, [provider.id]: 'Connection passed' }));
    } catch (error) {
      setActivityStates((current) => ({ ...current, [provider.id]: 'error' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]: error instanceof Error ? error.message : 'IRIS could not connect.',
      }));
    }
  }

  async function refreshModels(provider: ProviderConfig) {
    setActivityStates((current) => ({ ...current, [provider.id]: 'refreshing' }));
    setActivityMessages((current) => ({ ...current, [provider.id]: 'Refreshing model list…' }));
    try {
      const connected = await resolveProviderConnection(provider);
      const missingFields = missingProviderConnectionFields({
        ...connected,
        storedSecretFields: [],
      });
      if (missingFields.length) {
        throw new Error('Required provider credentials are not available.');
      }
      const refreshed = await refreshProviderModels(connected);
      upsertProvider({
        ...refreshed,
        connectionValues: provider.connectionValues,
      });
      setActivityStates((current) => ({ ...current, [provider.id]: 'ready' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]: `${refreshed.availableModels?.length ?? 0} models refreshed`,
      }));
    } catch (error) {
      setActivityStates((current) => ({ ...current, [provider.id]: 'error' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]:
          error instanceof Error ? error.message : 'IRIS could not refresh the model list.',
      }));
    }
  }

  async function removeProvider(provider: ProviderConfig) {
    try {
      if (provider.storedSecretFields?.length || provider.secretStored) {
        await deleteProviderSecrets(provider.id);
      }
      setProviders((current) => current.filter((candidate) => candidate.id !== provider.id));
      setActivityMessages((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    } catch (error) {
      setActivityStates((current) => ({ ...current, [provider.id]: 'error' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]:
          error instanceof Error ? error.message : 'IRIS could not remove the stored credential.',
      }));
    }
  }

  return (
    <div className="models-state">
      <div className="models-intro">
        <div>
          <p className="eyebrow">Model providers</p>
          <h2>Give IRIS a brain.</h2>
          <p>
            Keep local and cloud providers side by side. IRIS reads their real model lists only
            after you save credentials or request a refresh.
          </p>
        </div>
        <div className="provider-actions">
          <label className="provider-catalog-picker">
            <span>Provider type</span>
            <select
              aria-label="Provider type"
              value={catalogChoice}
              onChange={(event) => setCatalogChoice(event.target.value as ProviderCatalogId)}
            >
              <optgroup label={`Ready in IRIS (${supportedCatalog.length})`}>
                {supportedCatalog.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
              {pendingCatalog.length > 0 && (
                <optgroup label={`Listed · adapter needed (${pendingCatalog.length})`}>
                  {pendingCatalog.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <button
            className="soft-button primary-button"
            disabled={!selectedCatalogEntry?.supported}
            onClick={startAdding}
          >
            ＋ Add provider
          </button>
        </div>
      </div>

      <div className="provider-catalog-note">
        <strong>{selectedCatalogEntry?.name ?? 'Provider directory'}</strong>
        <span>
          {selectedCatalogEntry?.description ?? 'No provider entry is available.'}{' '}
          {selectedCatalogEntry?.supportReason}
        </span>
        <small>
          {catalog.length} providers · {supportedCatalog.length} ready in IRIS ·{' '}
          {catalogSync === 'current'
            ? 'directory current'
            : catalogSync === 'offline'
              ? 'using cached directory'
              : 'syncing directory…'}
        </small>
      </div>

      {providers.length === 0 && !draft && (
        <div className="provider-empty">
          <span>○</span>
          <div>
            <strong>No providers configured</strong>
            <p>IRIS will keep this space quiet until a real provider is connected.</p>
          </div>
        </div>
      )}
      <div className="provider-list">
        {providers.map((provider) => {
          const catalogId = providerCatalogIdForConfig(provider);
          const activity = activityStates[provider.id];
          return (
            <article className="provider-row" key={provider.id}>
              <div className="provider-icon">{catalogId === 'ollama' ? '◎' : '✦'}</div>
              <div className="provider-details">
                <strong>{provider.name}</strong>
                <span>
                  {provider.model || 'No model selected'} · {provider.endpoint}
                </span>
                {activityMessages[provider.id] && (
                  <small className={activity === 'error' ? 'provider-error' : ''}>
                    {activityMessages[provider.id]}
                  </small>
                )}
                {!activityMessages[provider.id] && provider.modelsRefreshedAt && (
                  <small>Models refreshed {formatMemoryDate(provider.modelsRefreshedAt)}</small>
                )}
              </div>
              <div className="provider-status">
                {activity === 'connected'
                  ? 'Connected'
                  : activity === 'testing'
                    ? 'Testing…'
                    : activity === 'refreshing'
                      ? 'Refreshing…'
                      : activity === 'error'
                        ? 'Unavailable'
                        : !provider.model.trim()
                          ? 'Needs model'
                          : provider.availableModels?.length
                            ? `${provider.availableModels.length} models`
                            : provider.storedSecretFields?.length
                              ? desktopRuntime
                                ? 'Stored securely'
                                : 'Session key expired'
                              : provider.connectionValues?.apiKey || provider.apiKey
                                ? 'Credentials in session'
                                : provider.kind === 'ollama' || provider.credentialMode === 'none'
                                  ? 'Local'
                                  : provider.credentialMode === 'optional'
                                    ? 'Key optional'
                                    : 'Needs key'}
              </div>
              <button
                className="row-button"
                disabled={activity === 'testing' || activity === 'refreshing'}
                onClick={() => void refreshModels(provider)}
              >
                Models
              </button>
              <button
                className="row-button"
                disabled={activity === 'testing' || activity === 'refreshing'}
                onClick={() => void testConnection(provider)}
              >
                Test
              </button>
              <button
                className="row-button"
                onClick={() => {
                  setErrors([]);
                  setDraft(provider);
                }}
              >
                Edit
              </button>
              <button
                className="row-button danger-button"
                onClick={() => void removeProvider(provider)}
              >
                Remove
              </button>
            </article>
          );
        })}
      </div>

      {draft && (
        <div className="provider-editor">
          <div className="editor-heading">
            <div>
              <p className="eyebrow">Configure provider</p>
              <h3>{catalogEntryForConfig(draft).name}</h3>
              <span className="provider-editor-description">
                {catalogEntryForConfig(draft).description}
              </span>
            </div>
            <button className="row-button" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          <label>
            Display name
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            Endpoint URL
            <input
              value={draft.endpoint}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  endpoint: event.target.value,
                  availableModels: undefined,
                  modelsRefreshedAt: undefined,
                })
              }
            />
          </label>
          <label>
            {draft.kind === 'azure-openai' ? 'Deployment name' : 'Default model'}
            {draft.availableModels?.length && draft.kind !== 'azure-openai' ? (
              <select
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              >
                {draft.availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                placeholder={
                  draft.kind === 'azure-openai'
                    ? 'Your Azure deployment name'
                    : 'Loaded from the provider after save'
                }
              />
            )}
          </label>
          {providerConnectionFields(draft).map((field) => (
            <label key={field.id}>
              {field.label}
              {!field.required && ' (optional)'}{' '}
              {field.secret && (
                <span className="field-note">
                  {desktopRuntime ? 'stored in OS keyring' : 'kept in memory only in preview'}
                </span>
              )}
              <input
                type={field.secret ? 'password' : 'text'}
                value={draft.connectionValues?.[field.id] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    connectionValues: {
                      ...(draft.connectionValues ?? {}),
                      [field.id]: event.target.value,
                    },
                    availableModels: field.id === 'apiVersion' ? undefined : draft.availableModels,
                    modelsRefreshedAt:
                      field.id === 'apiVersion' ? undefined : draft.modelsRefreshedAt,
                  })
                }
                placeholder={
                  field.secret && draft.storedSecretFields?.includes(field.id)
                    ? `Stored ${field.label.toLowerCase()} will be reused`
                    : field.placeholder
                }
              />
            </label>
          ))}
          {draft.kind === 'azure-openai' && draft.availableModels?.length && (
            <p className="provider-field-help">
              Azure reports {draft.availableModels.length} accessible base models. Deployment names
              are resource-specific and remain explicit.
            </p>
          )}
          {errors.length > 0 && (
            <div className="form-errors">
              {errors.map((error) => (
                <span key={error}>{error}</span>
              ))}
            </div>
          )}
          <button
            className="soft-button primary-button save-provider"
            disabled={saving}
            onClick={() => void saveDraft()}
          >
            {saving ? 'Saving and refreshing…' : 'Save provider'}
          </button>
        </div>
      )}
    </div>
  );
}

function WindowFrame({
  win,
  onClose,
  onFocus,
  onChange,
}: {
  win: DesktopWindow;
  onClose: () => void;
  onFocus: () => void;
  onChange: (next: DesktopWindow) => void;
}) {
  const frameRef = useRef<HTMLElement | null>(null);
  const interactionRef = useRef<{
    kind: 'move' | 'resize';
    pointerId: number;
    start: DesktopWindow;
    startX: number;
    startY: number;
    grabX: number;
    grabY: number;
    latest: DesktopWindow;
    animationFrame: number | null;
  } | null>(null);

  function paintInteraction() {
    const interaction = interactionRef.current;
    const frame = frameRef.current;
    if (!interaction || !frame) return;

    if (interaction.kind === 'move') {
      const deltaX = interaction.latest.x - interaction.start.x;
      const deltaY = interaction.latest.y - interaction.start.y;
      frame.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    } else {
      frame.style.width = `${interaction.latest.width}px`;
      frame.style.height = `${interaction.latest.height}px`;
    }
    interaction.animationFrame = null;
  }

  function scheduleInteraction(next: DesktopWindow) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    interaction.latest = next;
    if (interaction.animationFrame === null) {
      interaction.animationFrame = requestAnimationFrame(paintInteraction);
    }
  }

  function finishInteraction(pointerId: number) {
    const interaction = interactionRef.current;
    const frame = frameRef.current;
    if (!interaction || interaction.pointerId !== pointerId) return;

    if (interaction.animationFrame !== null) {
      cancelAnimationFrame(interaction.animationFrame);
      interaction.animationFrame = null;
    }
    paintInteraction();

    if (frame) {
      frame.style.left = `${interaction.latest.x}px`;
      frame.style.top = `${interaction.latest.y}px`;
      frame.style.width = `${interaction.latest.width}px`;
      frame.style.height = `${interaction.latest.height}px`;
      frame.style.transform = '';
      frame.classList.remove('is-interacting', 'is-moving', 'is-resizing');
    }

    const next = interaction.latest;
    interactionRef.current = null;
    onChange(next);
  }

  useEffect(
    () => () => {
      const animationFrame = interactionRef.current?.animationFrame;
      if (animationFrame !== null && animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }
    },
    [],
  );

  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    interactionRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      start: win,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - win.x,
      grabY: event.clientY - win.y,
      latest: win,
      animationFrame: null,
    };
    frameRef.current?.classList.add('is-interacting', 'is-moving');
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function drag(event: React.PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.kind !== 'move' || interaction.pointerId !== event.pointerId) {
      return;
    }
    scheduleInteraction(
      moveWindow(
        interaction.start,
        event.clientX,
        event.clientY,
        interaction.grabX,
        interaction.grabY,
      ),
    );
  }

  function resize(event: React.PointerEvent<HTMLButtonElement>) {
    const interaction = interactionRef.current;
    if (
      !interaction ||
      interaction.kind !== 'resize' ||
      interaction.pointerId !== event.pointerId
    ) {
      return;
    }
    scheduleInteraction(
      resizeWindow(
        interaction.start,
        event.clientX - interaction.startX,
        event.clientY - interaction.startY,
      ),
    );
  }

  return (
    <section
      ref={frameRef}
      className="iris-window"
      style={{ left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z }}
      onPointerDown={onFocus}
      aria-label={win.title}
    >
      <div
        className="window-titlebar"
        onPointerDown={beginDrag}
        onPointerMove={drag}
        onPointerUp={(event) => finishInteraction(event.pointerId)}
        onPointerCancel={(event) => finishInteraction(event.pointerId)}
        onLostPointerCapture={(event) => finishInteraction(event.pointerId)}
      >
        <div className="window-title">
          <span className="window-dot" />
          {win.title}
        </div>
        <button className="icon-button" aria-label={`Close ${win.title}`} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="window-content">
        {win.objectType === 'welcome' ? (
          <WelcomeState />
        ) : win.objectType === 'agents' ? (
          <AgentsState />
        ) : win.objectType === 'projects' ? (
          <ProjectsState />
        ) : win.objectType === 'github' ? (
          <GitHubState />
        ) : win.objectType === 'schedules' ? (
          <SchedulesState />
        ) : win.objectType === 'workspace' ? (
          <WorkspaceState />
        ) : win.objectType === 'models' ? (
          <ModelsState />
        ) : win.objectType === 'memory' ? (
          <MemoryState />
        ) : win.objectType === 'skills' ? (
          <SkillsState />
        ) : win.objectType === 'connections' ? (
          <McpState />
        ) : win.objectType === 'channels' ? (
          <ChannelsWindow />
        ) : win.objectType === 'settings' ? (
          <PermissionsState />
        ) : (
          <EmptyState type={win.objectType} />
        )}
      </div>
      <button
        className="resize-handle"
        aria-label={`Resize ${win.title}`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFocus();
          interactionRef.current = {
            kind: 'resize',
            pointerId: event.pointerId,
            start: win,
            startX: event.clientX,
            startY: event.clientY,
            grabX: 0,
            grabY: 0,
            latest: win,
            animationFrame: null,
          };
          frameRef.current?.classList.add('is-interacting', 'is-resizing');
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={resize}
        onPointerUp={(event) => finishInteraction(event.pointerId)}
        onPointerCancel={(event) => finishInteraction(event.pointerId)}
        onLostPointerCapture={(event) => finishInteraction(event.pointerId)}
      />
    </section>
  );
}

export function App() {
  const [windows, setWindows] = useState<DesktopWindow[]>(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('preview=desktop')) {
      return [
        {
          id: 'win-agents',
          objectType: 'agents',
          title: 'Agents',
          x: 60,
          y: 80,
          width: 820,
          height: 680,
          z: 11,
        },
        {
          id: 'win-workspace',
          objectType: 'workspace',
          title: 'Workspace',
          x: 920,
          y: 110,
          width: 760,
          height: 640,
          z: 12,
        },
      ];
    }
    return loadWindows();
  });
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('iris.theme') === 'dark');
  const [workspaceMount, setWorkspaceMount] = useState<WorkspaceMount | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(
    () => isOnboardingNeeded() && !window.location.search.includes('onboarding=false'),
  );
  const [availableUpdate, setAvailableUpdate] = useState<ReleaseInfo | null>(null);
  const [widgetMode, setWidgetMode] = useState(false);
  const [chatStarted, setChatStarted] = useState(false);
  const [query, setQuery] = useState('');
  const [sudoPasswordRequest, setSudoPasswordRequest] = useState<SudoPasswordRequest | null>(
    null,
  );
  const topZ = useMemo(
    () => windows.reduce((max, win) => Math.max(max, win.z), windowLayerBase),
    [windows],
  );

  useEffect(() => saveWindows(windows), [windows]);

  useEffect(() => {
    localStorage.setItem('iris.theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => startScheduledRuntime(), []);

  useEffect(() => {
    let active = true;
    void checkLatestRelease().then((release) => {
      if (active && release) {
        const dismissed = localStorage.getItem(`iris.update.dismissed.${release.version}`);
        if (!dismissed) setAvailableUpdate(release);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => onSudoPasswordRequestChange(setSudoPasswordRequest), []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void workspaceRepository.get().then((mount) => {
        if (active) setWorkspaceMount(mount);
      });
    };
    refresh();
    const unsubscribe = subscribeWorkspace(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  function openObject(type: IrisObjectType | 'welcome') {
    const existing = windows.find((win) => win.objectType === type);
    if (existing) {
      focus(existing.id);
      return;
    }
    setWindows((current) => [...current, defaultWindow(type, topZ + 1)]);
  }

  function focus(id: string) {
    setWindows((current) => {
      const highestZ = current.reduce((max, win) => Math.max(max, win.z), windowLayerBase);
      const target = current.find((win) => win.id === id);
      if (!target || target.z === highestZ) return current;
      return current.map((win) => (win.id === id ? { ...win, z: highestZ + 1 } : win));
    });
  }

  function submitCommand(event: React.FormEvent) {
    event.preventDefault();
    const target = resolveWorkspaceIntent(query);
    if (target) {
      openObject(target);
      setQuery('');
      return;
    }
    setChatStarted(true);
  }

  if (widgetMode) {
    return <DesktopWidget onRestore={() => setWidgetMode(false)} darkMode={darkMode} />;
  }

  return (
    <main
      className={`desktop-shell ${chatStarted ? 'chat-active' : ''} ${darkMode ? 'dark-mode' : ''}`}
    >
      <header className="topbar">
        <div className="brand">
          <IrisMark />
          <span>IRIS</span>
        </div>
        <div className="top-status">
          <span className="status-dot" />{' '}
          {workspaceMount ? `${workspaceMount.name} mounted` : 'No folder mounted'}
        </div>
        <div className="top-actions">
          <button
            className="widget-toggle-btn"
            onClick={() => setWidgetMode(true)}
            title="Minimér til Desktop Desklet"
            aria-label="Desktop widget mode"
          >
            <span aria-hidden="true">🛸</span> Desklet
          </button>
          <button
            className="theme-toggle"
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkMode ? 'Light mode' : 'Dark mode'}
            onClick={() => setDarkMode((current) => !current)}
          >
            {darkMode ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <SystemPanel />

      <section className="command-stage">
        <div className="stage-mark">
          <IrisMark />
        </div>
        <p className="eyebrow">Intelligent Reasoning & Integration System</p>
        <h1>What would you like to work on?</h1>
        {chatStarted ? (
          <ChatDesklet
            initialQuery={query}
            onStarted={() => setChatStarted(true)}
            onReset={() => {
              setChatStarted(false);
              setQuery('');
            }}
          />
        ) : (
          <form className="command-bar" onSubmit={submitCommand}>
            <SearchIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setChatStarted(true)}
              placeholder="Start a chat or open an object…"
              aria-label="IRIS command"
            />
            <kbd>Enter</kbd>
          </form>
        )}
      </section>

      <section className="desktop-objects" aria-label="IRIS objects">
        {objects.slice(0, 4).map(({ type, label, Icon }) => (
          <button
            className="desktop-object"
            key={type}
            onDoubleClick={() => openObject(type)}
            onClick={() => openObject(type)}
          >
            <span className={`object-glyph object-${type}`}>
              <Icon />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </section>

      {windows.map((win) => (
        <WindowFrame
          key={win.id}
          win={win}
          onClose={() => setWindows((current) => current.filter((item) => item.id !== win.id))}
          onFocus={() => focus(win.id)}
          onChange={(next) =>
            setWindows((current) =>
              current.map((item) =>
                item.id === win.id
                  ? {
                      ...item,
                      x: next.x,
                      y: next.y,
                      width: next.width,
                      height: next.height,
                    }
                  : item,
              ),
            )
          }
        />
      ))}

      <nav className="dock" aria-label="IRIS dock">
        <button className="dock-item" onClick={() => setWindows([])} aria-label="Clear workspace">
          <HomeIcon />
        </button>
        <span className="dock-separator" />
        {objects.map(({ type, label, Icon }) => (
          <button
            key={type}
            className="dock-item"
            onClick={() => openObject(type)}
            aria-label={label}
            title={label}
          >
            <Icon />
            {windows.some((win) => win.objectType === type) && <span className="running-dot" />}
          </button>
        ))}
      </nav>

      {sudoPasswordRequest && (
        <SudoPasswordPromptModal
          command={sudoPasswordRequest.command}
          onSubmit={(password) => resolveSudoPasswordRequest(password)}
          onCancel={() => resolveSudoPasswordRequest(null)}
        />
      )}

      {showOnboarding && (
        <OnboardingWizard
          onFinish={() => setShowOnboarding(false)}
          darkMode={darkMode}
        />
      )}

      {availableUpdate && (
        <UpdateNotificationModal
          release={availableUpdate}
          onDismiss={() => {
            localStorage.setItem(
              `iris.update.dismissed.${availableUpdate.version}`,
              'true',
            );
            setAvailableUpdate(null);
          }}
          darkMode={darkMode}
        />
      )}
    </main>
  );
}
