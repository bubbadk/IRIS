import type { RepositoryTransactions } from '../../../apps/desktop/src/repositoryStorage';

/**
 * IRIS Phase 2H.1 — cross-process exclusive agent execution ownership.
 *
 * The process-local `AgentExecutionLeaseRegistry` stays the fast path. This document is the
 * cross-process authority behind it: one repository document holds one lease record per agent,
 * written through the established `RepositoryTransactions` optimistic-CAS boundary. Two
 * processes that race for the same agent both snapshot the same revision; exactly one commit
 * wins, the loser retries against fresh state, sees a live foreign holder and is refused.
 *
 * Liveness without heartbeats: a record carries the owning process id plus a random
 * per-runtime instance nonce. A lease is recoverable only when its recorded process is
 * *positively* gone: the probe must answer `{ status: 'dead' }` (Unix `ESRCH`). Probes that
 * fail, return an unexpected shape, or cannot establish existence answer
 * `{ status: 'unknown' }` and deny takeover — Unknown is never Dead. A live foreign runtime
 * (different instance, even with a recycled pid) is never overridden. A corrupt lease
 * document fails closed: acquisition throws and the turn never starts on unknown lease state.
 */

/** Minimal storage view a transaction hands to the decision logic. */
export interface LeaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ProcessLiveness =
  | { status: 'alive' }
  | { status: 'dead' }
  | { status: 'unknown'; reason: string };

/** Validate untrusted IPC responses; legacy booleans cannot establish death. */
export function normalizeProcessLiveness(value: unknown): ProcessLiveness {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (result.status === 'alive') return { status: 'alive' };
    if (result.status === 'dead') return { status: 'dead' };
    if (result.status === 'unknown') return { status: 'unknown', reason: 'Process liveness is unavailable.' };
  }
  return { status: 'unknown', reason: 'Invalid process liveness response.' };
}

/** Process identity + liveness probes, provided by the host (Tauri) or the test harness. */
export interface CrossProcessLeaseIdentity {
  /** The OS process id this runtime executes in. */
  pid(): Promise<number>;
  /** Random nonce that is stable for this JS runtime's lifetime; defeats pid reuse. */
  instance(): string;
  /** Only positively established death permits foreign-owner recovery. */
  liveness(pid: number): Promise<ProcessLiveness>;
}

/** The admission port `AgentExecutionCoordination.crossProcess` consumes. */
export interface CrossProcessLeasePort {
  acquire(
    agentId: string,
    ownerId: string,
    ownerKind: string,
    at: string,
    runId?: string,
  ): Promise<boolean>;
  release(agentId: string, ownerId: string): Promise<void>;
  inspect(agentId: string): Promise<{ ownerId?: string } | undefined>;
  /**
   * Phase 2H.2 — the lease's raw ownership state with a tri-state liveness reading, so
   * reconciliation can distinguish a live foreign holder from an unknown one without
   * attempting any acquisition. `undefined` when no lease record exists.
   */
  holderStatus?(agentId: string): Promise<CrossProcessHolderStatus | undefined>;
}

/** What the authority knows about one lease holder right now. */
export interface CrossProcessHolderStatus {
  ownerId: string;
  /** False when the holder is this runtime's own record; true for any other instance. */
  foreign: boolean;
  /** Tri-state liveness of the recorded process (own instance is always alive). */
  liveness: ProcessLiveness['status'];
}

export interface CrossProcessLeaseRecord {
  agentId: string;
  ownerId: string;
  ownerKind: string;
  processId: number;
  processInstance: string;
  acquiredAt: string;
  runId?: string;
}

export const agentLeaseStorageKey = 'iris.agents.execution-leases.v1';

export function decodeExecutionLeases(raw: string | null): Record<string, CrossProcessLeaseRecord> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fail closed with a controlled error: a corrupt document must never read as "free".
    throw new Error('Saved agent execution leases are invalid. No turn was started.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Saved agent execution leases are invalid. No turn was started.');
  const out: Record<string, CrossProcessLeaseRecord> = {};
  for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = value as Partial<CrossProcessLeaseRecord>;
    if (
      !value ||
      typeof record.agentId !== 'string' ||
      typeof record.ownerId !== 'string' ||
      typeof record.ownerKind !== 'string' ||
      typeof record.processId !== 'number' ||
      typeof record.processInstance !== 'string' ||
      typeof record.acquiredAt !== 'string'
    )
      throw new Error('Saved agent execution leases are invalid. No turn was started.');
    out[agentId] = value as CrossProcessLeaseRecord;
  }
  return out;
}

/** A live, different runtime may keep the agent; anything provably dead is recoverable. */
async function holderBlocks(
  holder: CrossProcessLeaseRecord,
  identity: CrossProcessLeaseIdentity,
): Promise<boolean> {
  if (holder.processInstance === identity.instance()) return false; // same runtime: re-acquire
  return (await probeLiveness(holder, identity)) !== 'dead';
}

/** Normalized tri-state verdict for one lease holder (same instance always reads alive). */
async function probeLiveness(
  holder: CrossProcessLeaseRecord,
  identity: CrossProcessLeaseIdentity,
): Promise<ProcessLiveness['status']> {
  if (holder.processInstance === identity.instance()) return 'alive';
  try {
    return normalizeProcessLiveness(await identity.liveness(holder.processId)).status;
  } catch {
    return 'unknown'; // A failing probe never establishes death (Phase 2H.3).
  }
}

/**
 * Builds the cross-process authority over any transactional key/value store. `acquire`
 * returns `false` when a foreign owner's death cannot be established; storage or
 * decode failures throw, and the coordinator fails the turn closed.
 */
export function createLeaseAuthority(
  store: Pick<RepositoryTransactions, 'run'>,
  identity: CrossProcessLeaseIdentity,
): CrossProcessLeasePort {
  const keys = [agentLeaseStorageKey];
  return {
    async acquire(agentId, ownerId, ownerKind, at, runId) {
      let acquired = false;
      await store.run(async (storage: LeaseStorage) => {
        const leases = decodeExecutionLeases(storage.getItem(agentLeaseStorageKey));
        const holder = leases[agentId];
        if (holder && (await holderBlocks(holder, identity))) {
          acquired = false;
          return;
        }
        leases[agentId] = {
          agentId,
          ownerId,
          ownerKind,
          processId: await identity.pid(),
          processInstance: identity.instance(),
          acquiredAt: at,
          ...(runId ? { runId } : {}),
        };
        storage.setItem(agentLeaseStorageKey, JSON.stringify(leases));
        acquired = true;
      }, keys);
      return acquired;
    },
    async release(agentId, ownerId) {
      await store.run(async (storage: LeaseStorage) => {
        const leases = decodeExecutionLeases(storage.getItem(agentLeaseStorageKey));
        const holder = leases[agentId];
        // Only the recorded owner, from the runtime that acquired it, may release.
        if (
          !holder ||
          holder.ownerId !== ownerId ||
          holder.processInstance !== identity.instance()
        )
          return;
        delete leases[agentId];
        storage.setItem(agentLeaseStorageKey, JSON.stringify(leases));
      }, keys);
    },
    async inspect(agentId) {
      let holder: CrossProcessLeaseRecord | undefined;
      await store.run(async (storage: LeaseStorage) => {
        const leases = decodeExecutionLeases(storage.getItem(agentLeaseStorageKey));
        const candidate = leases[agentId];
        if (candidate && (await holderBlocks(candidate, identity))) holder = candidate;
      }, keys);
      return holder ? { ownerId: holder.ownerId } : undefined;
    },
    async holderStatus(agentId) {
      let status: CrossProcessHolderStatus | undefined;
      await store.run(async (storage: LeaseStorage) => {
        const leases = decodeExecutionLeases(storage.getItem(agentLeaseStorageKey));
        const candidate = leases[agentId];
        if (!candidate) return;
        status = {
          ownerId: candidate.ownerId,
          foreign: candidate.processInstance !== identity.instance(),
          liveness: await probeLiveness(candidate, identity),
        };
      }, keys);
      return status;
    },
  };
}
