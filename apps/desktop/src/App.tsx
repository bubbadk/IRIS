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
import { EmojiPicker } from './EmojiPicker';
import { ChatDesklet } from './ChatDesklet';
import { AgentsState, type CapabilityGroup } from './AgentsState';
import { ChannelsWindow } from './ChannelsState';
import { OnboardingWizard, isOnboardingNeeded } from './OnboardingWizard';
import { checkLatestRelease, type ReleaseInfo } from './updateChecker';
import { UpdateNotificationModal } from './UpdateNotificationModal';
import { MemoryBenchmarkView } from './MemoryBenchmarkView';
import { MemoryConstellationView } from './MemoryConstellationView';
import { MemoryState } from './MemoryState';
import { ModelsState } from './ModelsState';
import {
  type ModelImage,
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
  AgentsIcon,
  ChannelsIcon,
  GitHubIcon,
  HomeIcon,
  IrisMark,
  MemoryIcon,
  ModelsIcon,
  ProjectsIcon,
  SchedulesIcon,
  SearchIcon,
  SystemIcon,
  ConnectionsIcon,
  SkillsIcon,
  SubtitlesIcon,
  WorkspaceIcon,
} from './icons';
import { SubtitlesState } from './SubtitlesState';
import { WindowFrame } from './WindowFrame';
import {
  defaultWindow,
  loadWindows,
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
import { ProjectFlowStage } from './ProjectFlowStage';
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
import { CommandPalette } from './CommandPalette';
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

export const objects: Array<{
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
    type: 'subtitles',
    label: 'Subtitles',
    description: 'Intelligent chunk-based SRT/VTT subtitle translator.',
    Icon: SubtitlesIcon,
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

export function RichMessage({ content }: { content: string }) {
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

export function shortToolLabel(tool: { name: string; providerName?: string }): string {
  const raw = tool.providerName ?? tool.name;
  const withoutPrefix = raw.replace(/^mcp_(?:mcp_)?[0-9a-f-]{20,}_/i, '');
  return withoutPrefix.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
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
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

/** The "+" attach control: opens a small menu, currently just "Add files or photos". */
export function AttachButton({
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
export function AttachmentChips({
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
export function MessageImages({ images }: { images?: readonly ModelImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="message-images">
      {images.map((image, index) => (
        <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="Attached" />
      ))}
    </div>
  );
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

/** Drop handlers so files dragged from the OS land in the composer like picked ones. */
export function composerDropHandlers(onFiles: (files: FileList) => void) {
  return {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (files?.length) onFiles(files);
    },
  };
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



export function formatMemoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function ToolRequestView({ input, output }: { input: unknown; output?: unknown }) {
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
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const topZ = useMemo(
    () => windows.reduce((max, win) => Math.max(max, win.z), windowLayerBase),
    [windows],
  );

  useEffect(() => saveWindows(windows), [windows]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

      <SystemPanel onOpenProject={(id) => setFocusedProjectId(id)} />

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
          onOpenProject={(id) => setFocusedProjectId(id)}
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

      <CommandPalette
        open={paletteOpen}
        commands={objects.map(({ type, label, description }) => ({ type, label, description }))}
        onClose={() => setPaletteOpen(false)}
        onSelect={(type) => openObject(type)}
      />

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

      {focusedProjectId && (
        <ProjectFlowStage
          projectId={focusedProjectId}
          onClose={() => setFocusedProjectId(null)}
        />
      )}
    </main>
  );
}
