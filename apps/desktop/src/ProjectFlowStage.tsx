import { useEffect, useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import {
  addProjectTask,
  projectProgress,
  projectTaskState,
  type ProjectGraph,
  type ProjectTaskRun,
} from '@iris/workflows';
import {
  agentRepository,
  projectGraphRepository,
  projectTaskRunRepository,
  projectWorkerConversationRepository,
} from './persistence';
import {
  projectWorkflowRuntime,
  resolveProjectWorkerApproval,
  subscribeProjectRuntime,
} from './projectRuntime';
import { projectRunStatusLabel, sortProjectTaskRuns } from './projectRunHistory';
import type { ConversationMessage } from '@iris/agents';

export function ProjectFlowStage({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [project, setProject] = useState<ProjectGraph | null>(null);
  const [runs, setRuns] = useState<ProjectTaskRun[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [workerMessages, setWorkerMessages] = useState<ConversationMessage[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskDep, setNewTaskDep] = useState<string>('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Load project & runs
  useEffect(() => {
    let active = true;
    async function loadData() {
      const [g, r, a] = await Promise.all([
        projectGraphRepository.get(projectId),
        projectTaskRunRepository.list(projectId),
        agentRepository.list(),
      ]);
      if (!active) return;
      setProject(g);
      setRuns(sortProjectTaskRuns(r));
      setAgents(a);
      if (a.length > 0 && !selectedAgentId) {
        setSelectedAgentId(a[0]?.id || '');
      }
      if (g && g.tasks.length > 0 && !selectedTaskId) {
        const firstReady = g.tasks.find((t) => projectTaskState(g, t.id) === 'ready');
        setSelectedTaskId(firstReady ? firstReady.id : g.tasks[0]?.id || null);
      }
    }
    void loadData();
    const unsub = subscribeProjectRuntime((pid) => {
      if (pid === projectId) void loadData();
    });
    return () => {
      active = false;
      unsub();
    };
  }, [projectId]);

  // Load active worker conversation
  useEffect(() => {
    if (!selectedAgentId) return;
    let active = true;
    async function loadConv() {
      const conv = await projectWorkerConversationRepository.list(selectedAgentId);
      if (!active) return;
      setWorkerMessages(conv || []);
    }
    void loadConv();
    const interval = setInterval(loadConv, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedAgentId, runs]);

  if (!project) {
    return (
      <div className="project-flow-overlay" onClick={onClose}>
        <div className="project-flow-card" onClick={(e) => e.stopPropagation()}>
          <div className="project-flow-empty">Loading Project Flow Reactor…</div>
        </div>
      </div>
    );
  }

  const progress = projectProgress(project);
  const latestRun = runs[0] ?? null;
  const isWorkerActive = latestRun?.status === 'running' || latestRun?.status === 'queued';
  const isSuspended = latestRun?.status === 'suspended' && latestRun?.approval;
  const selectedTask = project.tasks.find((t) => t.id === selectedTaskId) ?? project.tasks[0] ?? null;
  const selectedTaskState = selectedTask ? projectTaskState(project, selectedTask.id) : 'ready';

  async function handleLaunchTask(taskId: string) {
    if (!project || isWorkerActive) return;
    const agent = agents.find((a) => a.id === selectedAgentId) || agents[0];
    if (!agent) {
      setError('Please select a worker agent before launching this task.');
      return;
    }

    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) return;

    setBusy(true);
    setError('');
    try {
      await projectWorkflowRuntime.launch({
        projectId: project.id,
        taskId: task.id,
        agentId: agent.id,
      });
      const updatedRuns = await projectTaskRunRepository.list(projectId);
      setRuns(sortProjectTaskRuns(updatedRuns));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelRun() {
    if (!latestRun || !isWorkerActive) return;
    setBusy(true);
    try {
      await projectWorkflowRuntime.cancel(latestRun.id);
      const updatedRuns = await projectTaskRunRepository.list(projectId);
      setRuns(sortProjectTaskRuns(updatedRuns));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleApproval(decision: 'approve' | 'deny') {
    if (!latestRun || !isSuspended) return;
    setBusy(true);
    setError('');
    try {
      await resolveProjectWorkerApproval(latestRun, decision);
      const updatedRuns = await projectTaskRunRepository.list(projectId);
      setRuns(sortProjectTaskRuns(updatedRuns));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !newTaskTitle.trim()) return;
    try {
      const depIds = newTaskDep ? [newTaskDep] : [];
      const updated = addProjectTask(project, {
        id: `task-${crypto.randomUUID()}`,
        title: newTaskTitle.trim(),
        description: newTaskDesc.trim() || undefined,
        dependencyIds: depIds,
        createdAt: new Date().toISOString(),
      });
      await projectGraphRepository.save(updated);
      setProject(updated);
      setNewTaskTitle('');
      setNewTaskDesc('');
      setNewTaskDep('');
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="project-flow-overlay" onClick={onClose}>
      <div className="project-flow-card" onClick={(e) => e.stopPropagation()}>
        {/* Stage Header */}
        <header className="project-flow-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="project-flow-icon">⚡</span>
              <p className="eyebrow">Project Flow Reactor</p>
            </div>
            <h2 className="project-flow-title">{project.title}</h2>
            <p className="project-flow-subtitle">{project.objective}</p>
          </div>

          <div className="project-flow-header-actions">
            <div className="project-flow-stats">
              <span className="stat-pill ready">Ready: {progress.ready}</span>
              <span className="stat-pill blocked">Blocked: {progress.blocked}</span>
              <span className="stat-pill done">Done: {progress.completed}/{progress.total}</span>
            </div>
            <button type="button" onClick={onClose} className="row-button close-btn">
              ✕
            </button>
          </div>
        </header>

        {error && (
          <div className="workspace-error" style={{ margin: '0 0 12px 0' }}>
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError('')}
              style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Worker Controls Bar */}
        <div className="project-flow-worker-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '11px', fontWeight: 650, color: 'var(--muted)' }}>
              Assigned Worker:
            </span>
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              disabled={isWorkerActive}
              className="project-worker-select"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.autonomy})
                </option>
              ))}
            </select>
            {isWorkerActive && (
              <span className="project-running-pulse">
                <span className="status-dot working" />
                Working on active task…
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            {isWorkerActive ? (
              <button
                type="button"
                onClick={handleCancelRun}
                disabled={busy}
                className="soft-button"
                style={{ color: '#dc2626' }}
              >
                ⏹ Stop Worker
              </button>
            ) : (
              selectedTask && selectedTaskState === 'ready' && (
                <button
                  type="button"
                  onClick={() => handleLaunchTask(selectedTask.id)}
                  disabled={busy}
                  className="soft-button primary-button"
                >
                  ▶ Launch &quot;{selectedTask.title}&quot;
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => setShowAddForm(!showAddForm)}
              className="soft-button"
            >
              {showAddForm ? '✕ Close Form' : '＋ Add Step'}
            </button>
          </div>
        </div>

        {/* Inline Approval Banner if Suspended */}
        {isSuspended && latestRun?.approval && (
          <div className="project-approval-banner">
            <div className="project-approval-info">
              <span className="approval-warning-icon">🛡️</span>
              <div>
                <strong>Worker requests permission for: {latestRun.approval.toolName}</strong>
                <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'var(--muted)' }}>
                  {latestRun.approval.reason || 'Confirm this action to proceed with the task execution.'}
                </p>
              </div>
            </div>
            <div className="project-approval-buttons">
              <button
                type="button"
                onClick={() => handleApproval('deny')}
                disabled={busy}
                className="soft-button approval-deny-btn"
              >
                ✕ Deny
              </button>
              <button
                type="button"
                onClick={() => handleApproval('approve')}
                disabled={busy}
                className="soft-button primary-button approval-apply-btn"
              >
                ✓ Apply & Resume
              </button>
            </div>
          </div>
        )}

        {/* Add Step Form */}
        {showAddForm && (
          <form className="project-add-step-form" onSubmit={handleAddTask}>
            <strong style={{ fontSize: '12px' }}>Add New Task Node to Flow Matrix</strong>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                placeholder="Step title (e.g. 5. Packaging & Deployment)"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                style={{ flex: 1 }}
              />
              <select
                value={newTaskDep}
                onChange={(e) => setNewTaskDep(e.target.value)}
                style={{ width: '220px' }}
              >
                <option value="">No prerequisite (Starts Ready)</option>
                {project.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Depends on: {t.title}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={2}
              placeholder="Completion criteria / instructions for the worker agent…"
              value={newTaskDesc}
              onChange={(e) => setNewTaskDesc(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
              <button type="button" onClick={() => setShowAddForm(false)} className="row-button">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newTaskTitle.trim()}
                className="soft-button primary-button"
              >
                Insert Step
              </button>
            </div>
          </form>
        )}

        {/* Main Body: Left Flow Matrix + Right Worker Stream */}
        <div className="project-flow-body">
          {/* Left Flow Matrix (The Anti-Kanban Reactive Chain) */}
          <section className="project-flow-matrix">
            <span className="flow-matrix-title">Flow Matrix & Task Chain</span>
            <div className="flow-matrix-chain">
              {project.tasks.map((task, index) => {
                const state = projectTaskState(project, task.id);
                const isSelected = selectedTaskId === task.id;
                const isTaskRunning = latestRun?.taskId === task.id && isWorkerActive;

                return (
                  <div key={task.id} className="flow-node-wrapper">
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      className={`flow-node-card state-${state} ${isSelected ? 'selected' : ''} ${isTaskRunning ? 'running' : ''}`}
                    >
                      <div className="flow-node-header">
                        <span className={`flow-node-badge state-${state}`}>
                          {state === 'completed'
                            ? '✓ Done'
                            : isTaskRunning
                              ? '● Running'
                              : state === 'ready'
                                ? '● Ready'
                                : '🔒 Blocked'}
                        </span>
                        <span className="flow-node-index">Step {index + 1}</span>
                      </div>
                      <strong className="flow-node-title">{task.title}</strong>
                      {task.description && (
                        <p className="flow-node-desc">{task.description}</p>
                      )}
                    </button>
                    {index < project.tasks.length - 1 && (
                      <div className="flow-connector-arrow">↓</div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Right Worker Interaction & Live Output */}
          <section className="project-worker-feed">
            <div className="project-worker-feed-header">
              <span>Live Worker Feed</span>
              {latestRun && (
                <span style={{ fontSize: '10.5px', color: 'var(--muted)' }}>
                  Status: <b>{projectRunStatusLabel(latestRun.status)}</b>
                </span>
              )}
            </div>

            <div className="project-worker-stream">
              {workerMessages.length === 0 ? (
                <div className="project-flow-empty" style={{ margin: 'auto' }}>
                  <strong>Agent Standing By</strong>
                  <p style={{ margin: 0, fontSize: '11px' }}>
                    Select a ready step on the left and click &quot;Launch&quot; to execute it autonomously.
                  </p>
                </div>
              ) : (
                workerMessages.map((msg, i) => {
                  const isUser = msg.role === 'user';
                  return (
                    <div key={i} className={`project-msg ${isUser ? 'user' : 'assistant'}`}>
                      <div className="project-msg-bubble">
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                          {msg.content}
                        </pre>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
