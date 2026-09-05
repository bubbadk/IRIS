import { displayedAgentModel } from './agentModelSelection';
import {
  AttachButton,
  AttachmentChips,
  composerDropHandlers,
  formatElapsed,
  formatMemoryDate,
  MessageImages,
  RichMessage,
  ToolRequestView,
} from './ChatContent';
import { ModelHandoffMarker } from './ModelHandoffMarker';
import { formatCount } from './systemTelemetry';

import { AgentEditor } from './AgentEditor';
import { describeCortexTurn, TurnStepRow } from './AgentTurnTrace';
import { useAgentsWorkspace } from './useAgentsWorkspace';
export function AgentsState() {
  const state = useAgentsWorkspace();
  const {
    agents,
    providers,
    loaded,
    historyLoaded,
    draftMessage,
    setDraftMessage,
    contextPacks,
    setSelectedContextTurnId,
    showContext,
    setShowContext,
    contextInspectorRef,
    conversationBodyRef,
    reasoningTextRef,
    showReasoning,
    setShowReasoning,
    elapsedSeconds,
    attachments,
    messages,
    assistantDraft,
    reasoningDraft,
    turnStartedAt,
    toolStatus,
    pendingApproval,
    pendingToolInput,
    busy,
    error,
    selectedAgent,
    selectedContextPack,
    selectedCortexTurn,
    selectedTurnSteps,
    selectAgent,
    beginNewAgent,
    beginEditAgent,
    attachFiles,
    removeAttachment,
    sendMessage,
    resolveAgentApproval,
    clearConversation,
  } = state;
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
      <AgentEditor editor={state} />
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
                  if (message.role === 'handoff') {
                    return (
                      <ModelHandoffMarker
                        key={`handoff-${message.handoff?.at ?? index}`}
                        message={message}
                      />
                    );
                  }
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
