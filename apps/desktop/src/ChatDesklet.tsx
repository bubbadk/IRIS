import type { AgentDefinition, ReasoningEffort } from '@iris/core';
import type { ModelImage } from '@iris/providers';
import { loadProviderConfigs } from '@iris/providers';
import type { SkillDefinition } from '@iris/skills';
import { useEffect, useRef, useState } from 'react';
import { displayedAgentModel } from './agentModelSelection';
import { agentRuntime, normalizeDesktopAgent } from './agentRuntime';
import { readAttachmentFile, type ComposerAttachment } from './attachments';
import {
  AttachButton,
  AttachmentChips,
  composerDropHandlers,
  formatElapsed,
  MessageImages,
  RichMessage,
  shortToolLabel,
  ToolRequestView,
} from './ChatContent';
import { EmojiPicker } from './EmojiPicker';
import { subscribeMcpServers } from './mcp';
import { ModelHandoffMarker } from './ModelHandoffMarker';
import { agentRepository, permissionRuleRepository } from './persistence';
import { listSkills, subscribeSkills } from './skills';
import { toolRegistry } from './tooling';
import { chatSessions, useChatSession } from './useChatSession';
import { recordUserActivity } from './userActivity';

export function ChatDesklet({
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
  const [draft, setDraft] = useState(initialQuery ?? '');
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [tools, setTools] = useState(() => toolRegistry.list());
  const [showReasoning, setShowReasoning] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactions, setReactions] = useState<Record<string, Record<string, number>>>({});
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const reasoningTextRef = useRef<HTMLParagraphElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const currentAgentState = useChatSession(selectedAgentId);
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
    const targetState = chatSessions.getSnapshot(targetAgentId);
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

    await chatSessions.send(targetAgentId, content, images);
  }

  async function setChatReasoningEffort(agent: AgentDefinition, effort: ReasoningEffort) {
    const updated = { ...agent, reasoningEffort: effort === 'none' ? undefined : effort };
    await agentRepository.save(updated);
    setAgents((current) => current.map((item) => (item.id === agent.id ? updated : item)));
    agentRuntime.refreshConfiguration(agent.id);
  }

  async function clearChat() {
    if (!selectedAgent) return;
    const targetAgentId = selectedAgent.id;
    await chatSessions.clear(targetAgentId);
    setAttachments([]);
    setShowHistory(false);
    onReset();
  }

  async function resolveApproval(decision: 'approve' | 'deny') {
    if (selectedAgentId) await chatSessions.resolve(selectedAgentId, decision);
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
    if (selectedAgentId) await chatSessions.stop(selectedAgentId);
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
                  {agent.name} {chatSessions.getSnapshot(agent.id).busy ? '● (working)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label
            className="desktop-agent-picker"
            title="How hard the model should think before answering."
          >
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
          if (message.role === 'handoff') {
            return (
              <ModelHandoffMarker
                key={`handoff-${message.handoff?.at ?? index}`}
                message={message}
              />
            );
          }
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
      <form
        className="desktop-chat-composer"
        onSubmit={send}
        {...composerDropHandlers((files) => void attachFiles(files))}
      >
        <AttachButton
          onFiles={(files) => void attachFiles(files)}
          disabled={!selectedAgent || busy}
        />
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
