import { useEffect, useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import {
  addProjectTask,
  createProjectGraph,
  projectProgress,
  projectTaskState,
  setProjectTaskCompletion,
  type ProjectGraph,
  type ProjectTaskRun,
} from '@iris/workflows';
import { agentRepository, projectGraphRepository, projectTaskRunRepository } from './persistence';
import { projectWorkflowRuntime, subscribeProjectRuntime } from './projectRuntime';
import { projectRunStatusLabel, sortProjectTaskRuns } from './projectRunHistory';

function formatProjectDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatProjectDateOrDash(value: string | undefined): string {
  return value ? formatProjectDate(value) : '—';
}

interface ProjectPreset {
  title: string;
  badge: string;
  objective: string;
  tasks: Array<{ title: string; description: string; depIndex?: number }>;
}

const projectPresets: ProjectPreset[] = [
  {
    title: 'Fuld Funktionsbygning',
    badge: '4 trin',
    objective: 'Byg en komplet softwarefunktion fra arkitektur til færdig UI og integration.',
    tasks: [
      {
        title: '1. Arkitektur & Datamodel',
        description: 'Analyser krav, definer datamodeller og tegn interfaces.',
      },
      {
        title: '2. Backend Logik & Værktøjer',
        description: 'Implementer kernetjenester og håndter forretningslogik.',
        depIndex: 0,
      },
      {
        title: '3. UI & Brugerflade',
        description: 'Byg visuelle komponenter og forbind dem til datalaget.',
        depIndex: 1,
      },
      {
        title: '4. Test & Verifikation',
        description: 'Kør enhedstests, fiks regressionsfejl og verificer funktionaliteten.',
        depIndex: 2,
      },
    ],
  },
  {
    title: 'Kode-audit & Testdækning',
    badge: '3 trin',
    objective: 'Gennemgå kodebasen for fejl, skriv enhedstests og dokumenter status.',
    tasks: [
      {
        title: '1. Codebase Analyse',
        description: 'Find ubehandlede edge-cases, manglende type safety og fejl.',
      },
      {
        title: '2. Enhedstests',
        description: 'Skriv grundige tests der afdækker kritiske funktioner.',
        depIndex: 0,
      },
      {
        title: '3. Fejlretning & Rapport',
        description: 'Udbedr fundne mangler og generer en opsummering.',
        depIndex: 1,
      },
    ],
  },
  {
    title: 'Release & Pakkering',
    badge: '3 trin',
    objective: 'Klargør projektet til udrulning, byg eksekverbare filer og lav release notes.',
    tasks: [
      {
        title: '1. Versionering & Changelog',
        description: 'Opdater versionsnumre og skriv overskuelig changelog.',
      },
      {
        title: '2. Kompiler Release Byg',
        description: 'Kør build scripts og generer produktionsbinærer.',
        depIndex: 0,
      },
      {
        title: '3. Røgtest & Verifikation',
        description: 'Start applikationen og verificer at alle kernefunktioner kører.',
        depIndex: 1,
      },
    ],
  },
];

export function ProjectsState() {
  const [projects, setProjects] = useState<ProjectGraph[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [runs, setRuns] = useState<ProjectTaskRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [showProjectEditor, setShowProjectEditor] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [dependencyId, setDependencyId] = useState('');
  const [launchingTaskId, setLaunchingTaskId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function applyProjectPreset(preset: ProjectPreset) {
    try {
      const now = new Date().toISOString();
      let graph = createProjectGraph({
        id: `project-${crypto.randomUUID()}`,
        title: preset.title,
        objective: preset.objective,
        createdAt: now,
      });

      const createdTaskIds: string[] = [];
      for (const t of preset.tasks) {
        const taskId = `task-${crypto.randomUUID()}`;
        const depId = t.depIndex !== undefined ? createdTaskIds[t.depIndex] : undefined;
        graph = addProjectTask(graph, {
          id: taskId,
          title: t.title,
          description: t.description,
          dependencyIds: depId ? [depId] : [],
          createdAt: new Date().toISOString(),
        });
        createdTaskIds.push(taskId);
      }

      await projectGraphRepository.save(graph);
      replaceProject(graph);
      setShowProjectEditor(false);
      setError('');
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : 'Could not create preset project.');
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      await projectWorkflowRuntime.reconcile();
      const stored = await projectGraphRepository.list();
      const storedRuns = await projectTaskRunRepository.list();
      const storedAgents = await agentRepository.list();
      if (!active) return;
      setProjects(stored);
      setRuns(storedRuns);
      setAgents(storedAgents);
      setSelectedId(stored[0]?.id ?? null);
      setSelectedAgentId(storedAgents[0]?.id ?? '');
      setShowProjectEditor(stored.length === 0);
      setLoaded(true);
    })();
    const unsubscribe = subscribeProjectRuntime(() => {
      void Promise.all([projectGraphRepository.list(), projectTaskRunRepository.list()]).then(
        ([stored, storedRuns]) => {
          if (!active) return;
          setProjects(stored);
          setRuns(storedRuns);
        },
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const selected = projects.find((project) => project.id === selectedId) ?? null;
  const progress = selected ? projectProgress(selected) : null;
  const selectedRuns = selected
    ? sortProjectTaskRuns(runs.filter((run) => run.projectId === selected.id))
    : [];
  const selectedRun = selectedRuns.find((run) => run.id === selectedRunId) ?? null;

  useEffect(() => {
    if (selectedRuns.some((run) => run.id === selectedRunId)) return;
    setSelectedRunId(selectedRuns[0]?.id ?? null);
  }, [selectedId, selectedRunId, runs]);

  function replaceProject(graph: ProjectGraph) {
    setProjects((current) => [graph, ...current.filter((project) => project.id !== graph.id)]);
    setSelectedId(graph.id);
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    try {
      const now = new Date().toISOString();
      const graph = createProjectGraph({
        id: `project-${crypto.randomUUID()}`,
        title,
        objective,
        createdAt: now,
      });
      await projectGraphRepository.save(graph);
      replaceProject(graph);
      setTitle('');
      setObjective('');
      setShowProjectEditor(false);
      setError('');
    } catch (projectError) {
      setError(
        projectError instanceof Error ? projectError.message : 'The project could not be saved.',
      );
    }
  }

  async function addTask(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      const next = addProjectTask(selected, {
        id: `task-${crypto.randomUUID()}`,
        title: taskTitle,
        description: taskDescription,
        dependencyIds: dependencyId ? [dependencyId] : [],
        createdAt: new Date().toISOString(),
      });
      await projectGraphRepository.save(next);
      replaceProject(next);
      setTaskTitle('');
      setTaskDescription('');
      setDependencyId('');
      setError('');
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : 'The task could not be saved.');
    }
  }

  async function toggleTask(taskId: string, completed: boolean) {
    if (!selected) return;
    try {
      const next = setProjectTaskCompletion(selected, taskId, completed, new Date().toISOString());
      await projectGraphRepository.save(next);
      replaceProject(next);
      setError('');
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : 'The task could not be updated.');
    }
  }

  async function launchTask(taskId: string) {
    if (!selected || !selectedAgentId) return;
    setLaunchingTaskId(taskId);
    setError('');
    try {
      const run = await projectWorkflowRuntime.launch({
        projectId: selected.id,
        taskId,
        agentId: selectedAgentId,
      });
      if (run.status === 'failed') setError(run.failure ?? 'The project worker failed.');
    } catch (launchError) {
      setError(
        launchError instanceof Error ? launchError.message : 'The project worker could not start.',
      );
    } finally {
      setLaunchingTaskId(null);
    }
  }

  async function cancelRun(run: ProjectTaskRun) {
    setCancellingRunId(run.id);
    setError('');
    try {
      await projectWorkflowRuntime.cancel(run.id);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : 'The project worker could not be cancelled.',
      );
    } finally {
      setCancellingRunId(null);
    }
  }

  return (
    <div className="projects-state">
      <header className="projects-heading">
        <div>
          <p className="eyebrow">Project graphs</p>
          <h2>Shape work before it runs.</h2>
          <p>
            Create durable tasks and prerequisites. The graph records only work you explicitly add.
          </p>
        </div>
        <button
          className="soft-button primary-button"
          onClick={() => setShowProjectEditor((current) => !current)}
        >
          ＋ New project
        </button>
      </header>

      {showProjectEditor && (
        <div className="schedule-editor">
          <div className="schedule-presets-section">
            <div className="schedule-presets-header">
              <span className="schedule-presets-title">⚡ Projekt-skabeloner</span>
              <span className="schedule-presets-subtitle">Start hurtigt med en komplet opgavegraf og afhængigheder:</span>
            </div>
            <div className="schedule-presets-grid">
              {projectPresets.map((preset) => (
                <button
                  type="button"
                  key={preset.title}
                  className="schedule-preset-card"
                  onClick={() => void applyProjectPreset(preset)}
                >
                  <div className="preset-card-top">
                    <strong className="preset-card-title">{preset.title}</strong>
                    <span className="preset-card-badge">{preset.badge}</span>
                  </div>
                  <p className="preset-card-desc">{preset.objective}</p>
                </button>
              ))}
            </div>
          </div>

          <form className="project-editor" onSubmit={(event) => void createProject(event)}>
            <label>
              Projektnavn
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="f.eks. Byg ny feature eller modul"
              />
            </label>
            <label>
              Overordnet Mål (Objective)
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Beskriv det konkrete resultat som grafen skal opnå…"
                rows={2}
              />
            </label>
            <div className="project-editor-actions">
              {projects.length > 0 && (
                <button
                  className="row-button"
                  type="button"
                  onClick={() => setShowProjectEditor(false)}
                >
                  Cancel
                </button>
              )}
              <button
                className="soft-button primary-button"
                disabled={!title.trim() || !objective.trim()}
              >
                Opret projektgraf
              </button>
            </div>
          </form>
        </div>
      )}

      {!loaded ? (
        <div className="projects-empty">Indlæser lokale projekter…</div>
      ) : projects.length === 0 ? (
        <div className="projects-empty">
          <strong>Ingen projektgrafer endnu</strong>
          <p>
            Projekter lader dig definere trinvise opgaver, som agenter udfører i rækkefølge med
            afhængighedskontrol. Vælg en skabelon ovenfor eller opret din egen.
          </p>
        </div>
      ) : (
        <div className="projects-workspace">
          <aside className="project-list" aria-label="Projects">
            {projects.map((project) => {
              const itemProgress = projectProgress(project);
              return (
                <button
                  key={project.id}
                  className={project.id === selectedId ? 'selected' : ''}
                  onClick={() => {
                    setSelectedId(project.id);
                    setSelectedRunId(null);
                    setError('');
                  }}
                >
                  <strong>{project.title}</strong>
                  <span>
                    {itemProgress.completed}/{itemProgress.total} complete
                  </span>
                </button>
              );
            })}
          </aside>

          {selected && progress && (
            <section className="project-graph" aria-label={`${selected.title} task graph`}>
              <div className="project-summary">
                <div>
                  <p className="eyebrow">Active graph</p>
                  <h3>{selected.title}</h3>
                  <p>{selected.objective}</p>
                </div>
                <dl>
                  <div>
                    <dt>Ready</dt>
                    <dd>{progress.ready}</dd>
                  </div>
                  <div>
                    <dt>Blocked</dt>
                    <dd>{progress.blocked}</dd>
                  </div>
                  <div>
                    <dt>Done</dt>
                    <dd>{progress.completed}</dd>
                  </div>
                </dl>
              </div>

              <div className="project-runtime-truth">
                <div>
                  <span />
                  <p>
                    Ready tasks run only when you launch them. Success completes the task; failure
                    or approval suspension leaves dependents blocked.
                  </p>
                </div>
                <label>
                  Worker agent
                  <select
                    value={selectedAgentId}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                    disabled={agents.length === 0}
                  >
                    {agents.length === 0 ? (
                      <option value="">No agents configured</option>
                    ) : (
                      agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>

              <form className="task-composer" onSubmit={(event) => void addTask(event)}>
                <div className="task-fields">
                  <label>
                    Task
                    <input
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      placeholder="Add a concrete task…"
                    />
                  </label>
                  <label>
                    Prerequisite
                    <select
                      value={dependencyId}
                      onChange={(event) => setDependencyId(event.target.value)}
                    >
                      <option value="">None</option>
                      {selected.tasks.map((task) => (
                        <option key={task.id} value={task.id}>
                          {task.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Detail <span>optional</span>
                  <input
                    value={taskDescription}
                    onChange={(event) => setTaskDescription(event.target.value)}
                    placeholder="What makes this task complete?"
                  />
                </label>
                <button className="soft-button primary-button" disabled={!taskTitle.trim()}>
                  Add task
                </button>
              </form>

              {selected.tasks.length === 0 ? (
                <div className="task-graph-empty">
                  <strong>The graph is empty.</strong>
                  <p>Add the first real task; it will be ready immediately.</p>
                </div>
              ) : (
                <ol className="task-graph-list">
                  {selected.tasks.map((task) => {
                    const state = projectTaskState(selected, task.id);
                    const taskRuns = runs.filter(
                      (run) => run.projectId === selected.id && run.taskId === task.id,
                    );
                    const latestRun = taskRuns[0];
                    const activeRun = taskRuns.find((run) =>
                      ['queued', 'running', 'suspended'].includes(run.status),
                    );
                    const dependencies = task.dependencyIds.map(
                      (id) => selected.tasks.find((candidate) => candidate.id === id)?.title ?? id,
                    );
                    return (
                      <li key={task.id} data-state={state}>
                        <span className="task-node-marker" aria-hidden="true" />
                        <div className="task-node-copy">
                          <div>
                            <strong>{task.title}</strong>
                            <span className="task-state">{state}</span>
                          </div>
                          {task.description && <p>{task.description}</p>}
                          <small>
                            {dependencies.length > 0
                              ? `After ${dependencies.join(', ')}`
                              : `Added ${formatProjectDate(task.createdAt)}`}
                          </small>
                          {latestRun && (
                            <div className="task-run-summary" data-run-state={latestRun.status}>
                              <span>{latestRun.status}</span>
                              <small>
                                {latestRun.agentName}
                                {latestRun.status === 'suspended' && latestRun.approval
                                  ? ` · waiting for ${latestRun.approval.toolName}`
                                  : latestRun.status === 'failed'
                                    ? ` · ${latestRun.failure}`
                                    : latestRun.status === 'completed' && latestRun.output
                                      ? ` · ${latestRun.output}`
                                      : latestRun.status === 'cancelled'
                                        ? ' · Cancelled before completion'
                                        : ''}
                              </small>
                            </div>
                          )}
                        </div>
                        <div className="task-node-actions">
                          {state === 'ready' && (
                            <button
                              className="row-button run-task-button"
                              disabled={
                                !selectedAgentId ||
                                Boolean(activeRun) ||
                                launchingTaskId === task.id
                              }
                              onClick={() => void launchTask(task.id)}
                            >
                              {launchingTaskId === task.id
                                ? 'Starting…'
                                : activeRun
                                  ? activeRun.status
                                  : 'Launch'}
                            </button>
                          )}
                          {activeRun && (
                            <button
                              className="row-button"
                              disabled={cancellingRunId === activeRun.id}
                              onClick={() => void cancelRun(activeRun)}
                            >
                              {cancellingRunId === activeRun.id ? 'Cancelling…' : 'Cancel'}
                            </button>
                          )}
                          <button
                            className="row-button"
                            disabled={state === 'blocked' || Boolean(activeRun)}
                            onClick={() => void toggleTask(task.id, state !== 'completed')}
                          >
                            {state === 'completed'
                              ? 'Reopen'
                              : state === 'blocked'
                                ? 'Waiting'
                                : 'Complete manually'}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              <section className="project-history" aria-label="Project run history">
                <div className="project-section-heading">
                  <div>
                    <p className="eyebrow">Run history</p>
                    <h3>What has actually run</h3>
                  </div>
                  <span>
                    {selectedRuns.length} persisted run{selectedRuns.length === 1 ? '' : 's'}
                  </span>
                </div>
                {selectedRuns.length === 0 ? (
                  <div className="project-history-empty">
                    No worker runs recorded for this project yet. Launch a ready task to create the
                    first real run record.
                  </div>
                ) : (
                  <div className="project-history-layout">
                    <div className="project-history-list">
                      {selectedRuns.map((run) => {
                        const task = selected.tasks.find(
                          (candidate) => candidate.id === run.taskId,
                        );
                        return (
                          <button
                            key={run.id}
                            className={run.id === selectedRun?.id ? 'selected' : ''}
                            onClick={() => setSelectedRunId(run.id)}
                          >
                            <span className="project-history-row-top">
                              <strong>{task?.title ?? 'Removed task'}</strong>
                              <span className="task-state" data-run-state={run.status}>
                                {projectRunStatusLabel(run.status)}
                              </span>
                            </span>
                            <span>
                              {run.agentName} · updated {formatProjectDate(run.updatedAt)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {selectedRun && (
                      <article className="project-history-detail">
                        <div className="project-history-detail-heading">
                          <div>
                            <p className="eyebrow">Run detail</p>
                            <h4>
                              {selected.tasks.find((task) => task.id === selectedRun.taskId)
                                ?.title ?? 'Removed task'}
                            </h4>
                          </div>
                          <span className="task-state" data-run-state={selectedRun.status}>
                            {projectRunStatusLabel(selectedRun.status)}
                          </span>
                        </div>
                        <dl className="project-run-facts">
                          <div>
                            <dt>Agent</dt>
                            <dd>{selectedRun.agentName}</dd>
                          </div>
                          <div>
                            <dt>Created</dt>
                            <dd>{formatProjectDateOrDash(selectedRun.createdAt)}</dd>
                          </div>
                          <div>
                            <dt>Started</dt>
                            <dd>{formatProjectDateOrDash(selectedRun.startedAt)}</dd>
                          </div>
                          <div>
                            <dt>Updated</dt>
                            <dd>{formatProjectDateOrDash(selectedRun.updatedAt)}</dd>
                          </div>
                          <div>
                            <dt>Finished</dt>
                            <dd>
                              {formatProjectDateOrDash(
                                selectedRun.completedAt ??
                                  selectedRun.failedAt ??
                                  selectedRun.cancelledAt,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Runtime turn</dt>
                            <dd>{selectedRun.runtimeTurnId ?? 'Not started'}</dd>
                          </div>
                        </dl>
                        {selectedRun.approval && (
                          <div className="project-run-callout">
                            <strong>Approval</strong>
                            <p>{selectedRun.approval.toolName}</p>
                            <small>{selectedRun.approval.reason}</small>
                          </div>
                        )}
                        {selectedRun.output && (
                          <div className="project-run-copy">
                            <strong>Outcome</strong>
                            <p>{selectedRun.output}</p>
                          </div>
                        )}
                        {selectedRun.failure && (
                          <div className="project-run-callout error">
                            <strong>Failure</strong>
                            <p>{selectedRun.failure}</p>
                          </div>
                        )}
                        {selectedRun.status === 'cancelled' && (
                          <p className="project-run-muted">
                            Cancelled before completion. The originating task was not completed.
                          </p>
                        )}
                      </article>
                    )}
                  </div>
                )}
              </section>
            </section>
          )}
        </div>
      )}
      {error && <p className="project-error">{error}</p>}
    </div>
  );
}
