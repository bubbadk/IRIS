/**
 * IRIS Phase 2G §6–§8 — the one shared exclusive-execution reservation for this IRIS process.
 *
 * Every runtime that can exclusively execute an agent (interactive chat, the scheduled runtime, the
 * project worker runtime) resolves its reservation through this single registry instead of keeping a
 * private `Set<string>`. A `Map`-backed synchronous check-and-set is atomic in the application's
 * single-threaded model, which is what makes the reservation safe to take *before* an await.
 *
 * IRIS Phase 2H.1 — behind the local registry sits the cross-process authority: one lease
 * document in the shared repository, written through the optimistic-CAS transaction boundary.
 * A same-agent turn in another live IRIS process is refused even though this process's own
 * map is free. Browser preview (no Tauri) keeps the local-only behavior.
 */
import {
  AgentExecutionLeaseRegistry,
  createLeaseAuthority,
  normalizeProcessLiveness,
  type CrossProcessLeaseIdentity,
  type CrossProcessLeasePort,
} from '@iris/agents';
import type { ProjectWorkerReservation } from '@iris/workflows';

export const agentExecutionLeases = new AgentExecutionLeaseRegistry();

/** Owner identity for the interactive/scheduled coordinator (one per agent). */
export function agentRuntimeOwnerId(agentId: string): string {
  return `agent-runtime:${agentId}`;
}

type TauriCore = typeof import('@tauri-apps/api/core');
let tauri: TauriCore | undefined;
async function loadTauri(): Promise<TauriCore | undefined> {
  if (tauri) return tauri;
  try {
    tauri = await import('@tauri-apps/api/core');
    return tauri;
  } catch {
    return undefined;
  }
}

/** True only when the native process-identity commands answer with a real pid. */
async function isNativeRuntime(): Promise<boolean> {
  const core = await loadTauri();
  if (!core) return false;
  try {
    const pid = await core.invoke<number>('process_own_pid');
    return typeof pid === 'number' && Number.isFinite(pid) && pid > 0;
  } catch {
    return false;
  }
}

/**
 * The cross-process identity port backed by the native process-identity commands.
 * The instance nonce is fetched once here (the webview may reload while the OS process
 * survives, so Rust — not the webview — owns the instance identity).
 */
async function nativeIdentity(): Promise<CrossProcessLeaseIdentity> {
  const core = (await loadTauri())!;
  const nonce = await core.invoke<string>('process_instance_nonce');
  return {
    pid: async () => core.invoke<number>('process_own_pid'),
    instance: () => nonce,
    liveness: async (pid) => {
      try {
        return normalizeProcessLiveness(await core.invoke<unknown>('process_is_alive', { pid }));
      } catch {
        return { status: 'unknown', reason: 'Process liveness transport is unavailable.' };
      }
    },
  };
}

let authorityReady: Promise<CrossProcessLeasePort | undefined> | undefined;

/**
 * The shared cross-process authority, or `undefined` outside the native runtime.
 * Built once per process; every coordinator shares the same port and lease document.
 */
export function crossProcessAuthority(): Promise<CrossProcessLeasePort | undefined> {
  authorityReady ??= (async () => {
    if (!(await isNativeRuntime())) return undefined;
    // The native shell initializes durable storage before any UI mounts (main.tsx), so the
    // transaction view is ready here. This module must never trigger initialization itself:
    // importing it in a non-native test environment would touch native state.
    const { currentRepositoryTransactions } = await import('./repositoryStorage');
    const transactions = currentRepositoryTransactions();
    if (!transactions) return undefined;
    sharedPort = createLeaseAuthority(transactions, await nativeIdentity());
    return sharedPort;
  })();
  // Never leave an unresolved rejection dangling: a failed authority build keeps the
  // process-local registry as the only authority rather than crashing unrelated surfaces.
  authorityReady.catch(() => undefined);
  return authorityReady;
}

/**
 * The project runtime's view of the same registry. The project subsystem (a queue entry or a worker
 * run) owns the agent; the project agent-turn coordinator deliberately does not re-acquire it.
 * Phase 2H.1: `crossProcess` resolves from the same shared authority as chat and the scheduler,
 * so every exclusive-execution runtime in this process shares one lease document.
 */
export const projectWorkerReservations: ProjectWorkerReservation = {
  reserve: (agentId, ownerId, at) =>
    agentExecutionLeases.reserve({ agentId, ownerId, ownerKind: 'project', acquiredAt: at }),
  holder: (agentId) => {
    const holder = agentExecutionLeases.holder(agentId);
    return holder ? { ownerId: holder.ownerId } : undefined;
  },
  transfer: (agentId, fromOwnerId, toOwnerId, at, runId) =>
    agentExecutionLeases.transfer(agentId, fromOwnerId, toOwnerId, at, runId),
  release: (agentId, ownerId) => agentExecutionLeases.release(agentId, ownerId),
  get crossProcess() {
    return projectCrossProcess;
  },
};

let projectCrossProcess: import('@iris/workflows').ProjectWorkerReservation['crossProcess'];
let sharedPort: CrossProcessLeasePort | undefined;

/** Attaches the shared authority to the project reservation port (idempotent). */
export function attachCrossProcessAuthority(port: CrossProcessLeasePort): void {
  sharedPort = port;
  projectCrossProcess = {
    acquire: (agentId, ownerId, at, runId) => port.acquire(agentId, ownerId, 'project', at, runId),
    release: (agentId, ownerId) => port.release(agentId, ownerId),
    inspect: (agentId) => port.inspect(agentId),
    ...(port.holderStatus
      ? {
          holderStatus: (agentId) =>
            port.holderStatus!(agentId).then((holder) =>
              holder
                ? {
                    ownerId: holder.ownerId,
                    foreign: holder.foreign,
                    liveness: holder.liveness,
                  }
                : undefined,
            ),
        }
      : {}),
  };
}
