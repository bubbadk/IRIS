import { invoke } from '@tauri-apps/api/core';
import {
  ProjectQueueDispatcher,
  isNonTerminalProjectTaskRun,
  newestRunForEntry,
} from '@iris/workflows';
import { isTauriRuntime } from './credentials';
import {
  projectGraphRepository,
  projectQueueRepository,
  projectTaskRunRepository,
} from './persistence';
import {
  isProjectAgentAvailable,
  projectWorkflowRuntime,
  subscribeProjectRuntime,
} from './projectRuntime';
import { projectWorkerReservations } from './agentExecution';

const listeners = new Set<() => void>();
let owned = false;
let started = false;
let reconciled = false;
let timer: number | undefined;
let generation = 0;
let state: { status: 'starting' | 'running' | 'unavailable' | 'stopped'; message: string } = {
  status: 'stopped',
  message: 'The project queue has not started.',
};
const notify = () => listeners.forEach((listener) => listener());

export function projectQueueRuntimeStatus() {
  return { ...state };
}

export function subscribeProjectQueueRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const projectQueueDispatcher = new ProjectQueueDispatcher(
  projectGraphRepository,
  projectQueueRepository,
  {
    available: isProjectAgentAvailable,
    // A direct launch and a queue dispatch share one path; the dispatch boundary hook lets the
    // dispatcher persist the real run identity before the worker executes.
    launch: (input) => projectWorkflowRuntime.launch(input),
    // §11, §24 — busy is read from the authoritative worker-run lifecycle, so a launched worker
    // keeps blocking conflicting execution after its queue entry left the `claimed` state.
    busyAgentIds: async () =>
      (await projectTaskRunRepository.list())
        .filter(isNonTerminalProjectTaskRun)
        .map((run) => run.agentId),
    // §3, §4 — reconstruct the run identity of an entry whose launched state was never persisted.
    findRun: async (input) =>
      newestRunForEntry(await projectTaskRunRepository.list(input.projectId), input) ?? null,
  },
  undefined,
  projectWorkerReservations,
);

async function tick() {
  if (!started || !owned) return;
  try {
    await projectQueueDispatcher.tick();
    notify();
  } catch (error) {
    state = {
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
    notify();
  }
}

export function startProjectQueueRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  const epoch = ++generation;
  state = { status: 'starting', message: 'Checking exclusive project queue ownership…' };
  notify();
  const unsubscribeProjectRuntime = subscribeProjectRuntime(() => void tick());
  void (async () => {
    try {
      if (!isTauriRuntime())
        throw new Error(
          'Project queue execution requires the native desktop app. Browser preview does not run queued tasks.',
        );
      owned = await invoke<boolean>('acquire_schedule_owner');
      if (epoch !== generation) return;
      if (!owned)
        throw new Error(
          'Another IRIS process owns queued execution. Manage the queue in that process.',
        );
      if (!reconciled) {
        // Rebuild what IRIS actually knows before dispatching anything new: the queue's own
        // mid-dispatch entries, and the exclusive agents held by runs that are still active.
        await projectWorkflowRuntime.reconcile();
        await projectQueueDispatcher.reconcile();
        reconciled = true;
      }
      if (epoch !== generation) return;
      state = {
        status: 'running',
        message: 'Queued project tasks start once their dependencies and assigned agent are ready.',
      };
      notify();
      timer = window.setInterval(() => void tick(), 30_000);
      void tick();
    } catch (error) {
      if (epoch !== generation) return;
      state = {
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
      notify();
    }
  })();
  return () => {
    generation++;
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    started = false;
    owned = false;
    unsubscribeProjectRuntime();
  };
}
