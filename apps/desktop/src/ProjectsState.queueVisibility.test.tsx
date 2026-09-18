// @vitest-environment jsdom
/**
 * IRIS Phase 2G §25 — queue and dispatch outcomes must be visible in the Projects UI.
 *
 * A `needs-attention` entry, a removed entry, and a launched worker whose run already exists all
 * have to be readable on the task row, and no control may suggest that nothing happened.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGraph, ProjectQueueEntry, ProjectTaskRun } from '@iris/workflows';
import { ProjectsState } from './ProjectsState';

const graph: ProjectGraph = {
  version: 1,
  id: 'project',
  title: 'Export',
  objective: 'Ship the export.',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
  tasks: [
    {
      id: 'task',
      title: 'Write export',
      dependencyIds: [],
      turnLimit: 4,
      createdAt: '2026-09-17T10:00:00.000Z',
    },
  ],
};

const mocks = vi.hoisted(() => ({
  graphs: vi.fn(async () => [] as unknown[]),
  runs: vi.fn(async () => [] as unknown[]),
  queueList: vi.fn(async () => [] as unknown[]),
  queueGet: vi.fn(async () => null as unknown),
  queueSave: vi.fn(async () => undefined),
  queueEnqueue: vi.fn(async () => undefined),
  agents: vi.fn(async () => [
    {
      id: 'agent',
      name: 'Worker',
      autonomy: 'assist',
      approvalMode: 'ask',
      skillIds: [],
      toolIds: [],
    },
  ]),
  reconcile: vi.fn(async () => []),
  tick: vi.fn(async () => []),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock('./persistence', () => ({
  agentRepository: { list: mocks.agents },
  projectGraphRepository: { list: mocks.graphs, save: vi.fn(), get: vi.fn() },
  projectTaskRunRepository: { list: mocks.runs },
  projectQueueRepository: {
    list: mocks.queueList,
    get: mocks.queueGet,
    save: mocks.queueSave,
    enqueue: mocks.queueEnqueue,
  },
}));
vi.mock('./projectRuntime', () => ({
  projectWorkflowRuntime: { reconcile: mocks.reconcile, cancel: vi.fn() },
  subscribeProjectRuntime: mocks.subscribe,
}));
vi.mock('./KnowledgePanel', () => ({ KnowledgePanel: () => null }));
vi.mock('./projectQueueRuntime', () => ({
  projectQueueDispatcher: { tick: mocks.tick, reconcile: mocks.reconcile },
  subscribeProjectQueueRuntime: mocks.subscribe,
}));

let root: Root | null = null;

afterEach(() => {
  vi.clearAllMocks();
  const mounted = root;
  root = null;
  act(() => mounted?.unmount());
  document.body.innerHTML = '';
});

async function mount(entries: ProjectQueueEntry[], runs: ProjectTaskRun[] = []): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.graphs.mockResolvedValue([graph]);
  mocks.runs.mockResolvedValue(runs);
  mocks.queueList.mockResolvedValue(entries);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ProjectsState />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function buttonLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')].map((button) => button.textContent ?? '');
}

function queueEntry(overrides: Partial<ProjectQueueEntry>): ProjectQueueEntry {
  return {
    version: 1,
    id: 'entry',
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    status: 'queued',
    queuedAt: '2026-09-17T10:05:00.000Z',
    updatedAt: '2026-09-17T10:05:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<ProjectTaskRun> = {}): ProjectTaskRun {
  return {
    version: 1,
    id: 'run',
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    agentName: 'Worker',
    status: 'running',
    createdAt: '2026-09-17T10:06:00.000Z',
    updatedAt: '2026-09-17T10:06:00.000Z',
    startedAt: '2026-09-17T10:06:00.000Z',
    runtimeTurnId: 'turn',
    ...overrides,
  };
}

describe('M-25 — queue and dispatch failures are visible', () => {
  it('shows a needs-attention entry with the real failure reason and a way forward', async () => {
    const container = await mount([
      queueEntry({
        status: 'needs-attention',
        failureKind: 'configuration',
        updatedAt: '2026-09-17T10:09:00.000Z',
        message:
          'Worker run was not started after 3 attempts. IRIS will not retry automatically until the cause is fixed.',
      }),
    ]);
    expect(container.textContent).toContain('Queue dispatch needs attention');
    expect(container.textContent).toContain('IRIS will not retry automatically');
    expect(buttonLabels(container)).toContain('Queue again');
    expect(buttonLabels(container)).not.toContain('Queue');
  });

  it('shows a removed entry instead of silently dropping it', async () => {
    const container = await mount([
      queueEntry({
        status: 'cancelled',
        updatedAt: '2026-09-17T10:09:00.000Z',
        message: 'Removed from the project queue before dispatch.',
      }),
    ]);
    expect(container.textContent).toContain('Removed from the queue');
    expect(container.textContent).toContain('Removed from the project queue before dispatch.');
  });

  it('correlates a launched entry with the worker run it created', async () => {
    const container = await mount([
      queueEntry({
        status: 'launched',
        runId: 'run-42',
        failureKind: 'launched',
        updatedAt: '2026-09-17T10:09:00.000Z',
        message: 'Worker run run-42 was created. Follow its real status in project history.',
      }),
    ]);
    expect(container.textContent).toContain('Worker launched');
    expect(container.textContent).toContain('run-42');
    expect(container.querySelector('[data-run-id="run-42"]')).not.toBeNull();
  });

  it('reports a launch-boundary persistence failure without claiming the launch failed', async () => {
    const container = await mount([
      queueEntry({
        status: 'launched',
        runId: 'run-7',
        updatedAt: '2026-09-17T10:09:00.000Z',
        message:
          'Worker run run-7 was created, but IRIS could not save the queue update (Quota exceeded). The run exists and is the truth; reconcile before retrying this entry.',
      }),
    ]);
    expect(container.textContent).toContain('run-7 was created');
    expect(container.textContent).toContain('The run exists and is the truth');
    expect(container.textContent).not.toMatch(/could not be started|launch failed/i);
    expect(buttonLabels(container)).not.toContain('Queue');
  });

  it('keeps the pending entry visible while a dispatch is in flight', async () => {
    const container = await mount([
      queueEntry({ status: 'claimed', updatedAt: '2026-09-17T10:09:00.000Z' }),
    ]);
    expect(container.textContent).toContain('Queue dispatch in progress');
    expect(buttonLabels(container)).not.toContain('Queue');
    expect(buttonLabels(container)).not.toContain('Remove from queue');
  });

  it('offers removal only while an entry can still be withdrawn', async () => {
    const container = await mount([
      queueEntry({ status: 'queued', updatedAt: '2026-09-17T10:09:00.000Z' }),
    ]);
    expect(container.textContent).toContain('Queued');
    expect(buttonLabels(container)).toContain('Remove from queue');
  });

  it('reports the real state instead of overwriting a dispatch that already launched', async () => {
    const container = await mount([
      queueEntry({ id: 'entry', status: 'queued', updatedAt: '2026-09-17T10:09:00.000Z' }),
    ]);
    // The dispatcher claimed and launched this entry after the row was rendered.
    mocks.queueGet.mockResolvedValue(
      queueEntry({
        id: 'entry',
        status: 'launched',
        runId: 'run-1',
        updatedAt: '2026-09-17T10:09:30.000Z',
      }),
    );
    const remove = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Remove from queue',
    )!;
    await act(async () => {
      remove.click();
    });
    expect(mocks.queueSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('run-1 exists');
  });

  it('never offers Queue while a worker run really exists for the task', async () => {
    const container = await mount([], [run({ status: 'running' })]);
    expect(buttonLabels(container)).not.toContain('Queue');
    expect(buttonLabels(container)).not.toContain('Queue again');
  });

  it('shows both a settled outcome and a still-pending entry when both are real', async () => {
    const container = await mount([
      queueEntry({
        id: 'settled',
        status: 'needs-attention',
        updatedAt: '2026-09-17T10:09:00.000Z',
        message: 'No worker run was found for this entry.',
      }),
      queueEntry({
        id: 'pending',
        status: 'queued',
        updatedAt: '2026-09-17T10:10:00.000Z',
        message: undefined,
      }),
    ]);
    expect(container.textContent).toContain('Queue dispatch needs attention');
    expect(container.textContent).toContain('Queued');
    // The still-pending entry remains withdrawable even though an older attempt failed.
    expect(buttonLabels(container)).toContain('Remove from queue');
  });
});
