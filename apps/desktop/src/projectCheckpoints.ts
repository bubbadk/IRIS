import { validateAgentCheckpoint, type AgentCheckpoint } from '@iris/agents';
import {
  carriesQualityProvenance,
  isNonTerminalProjectTaskRun,
  type ProjectTaskRun,
} from '@iris/workflows';
import { LocalProjectTaskRunRepository } from './persistence';
import { readPersistedKeyedObject } from './persistenceIntegrity';
import { createDesktopRepository } from './repositoryStorage';
import { withStorageWrite } from './storageWrites';

const storageKey = 'iris.projects.worker-checkpoints.v1';
const runStorageKey = 'iris.projects.task-runs.v1';

/**
 * Global safety cap. A checkpoint contains a full conversation and model history, so the durable
 * collection must stay bounded. The cap is applied *after* run liveness: checkpoints for runs that
 * still exist and still need recovery are protected and the cap is exceeded rather than deleting
 * them. Because project task runs are themselves bounded (see `retainProjectTaskRuns`), this cap is
 * a backstop rather than the primary bound.
 */
const checkpointLimit = 200;

export interface CheckpointRetentionInput {
  records: Record<string, AgentCheckpoint>;
  runs: readonly ProjectTaskRun[];
  /** False when the task-run document has never been written in this repository database. */
  hasRunDocument: boolean;
  limit: number;
}

/**
 * Retention for durable worker checkpoints.
 *
 * A checkpoint is only ever requested by run id (`get(run.id)` for recovery and continue,
 * `get(previousRun.id)` for a continuation), so:
 *  - a checkpoint whose run no longer exists can never be read again and is pruned;
 *  - a checkpoint whose run still exists is kept while that run is non-terminal, carries human
 *    review provenance, or is the documented source of a live continuation;
 *  - the safety cap only removes checkpoints of finally closed runs, oldest first.
 *
 * If the task-run document was never written, no conclusion about liveness can be drawn, so nothing
 * is treated as an orphan and only the cap applies.
 */
export function retainCheckpoints(input: CheckpointRetentionInput): Record<string, AgentCheckpoint> {
  const byId = new Map(input.runs.map((run) => [run.id, run]));
  const protectedIds = new Set<string>();
  for (const run of input.runs) {
    if (!isNonTerminalProjectTaskRun(run) && !carriesQualityProvenance(run)) continue;
    protectedIds.add(run.id);
    if (isNonTerminalProjectTaskRun(run) && run.previousRunId) protectedIds.add(run.previousRunId);
  }
  const retained = Object.create(null) as Record<string, AgentCheckpoint>;
  const prunable: { key: string; order: string }[] = [];
  for (const [key, checkpoint] of Object.entries(input.records)) {
    const run = byId.get(key);
    if (input.hasRunDocument && !run) continue;
    if (protectedIds.has(key)) {
      retained[key] = checkpoint;
      continue;
    }
    prunable.push({ key, order: `${run ? run.updatedAt || run.createdAt : ''}\u0000${key}` });
  }
  const room = Math.max(0, input.limit - Object.keys(retained).length);
  prunable.sort((left, right) => left.order.localeCompare(right.order));
  for (const { key } of prunable.slice(Math.max(0, prunable.length - room))) {
    retained[key] = input.records[key]!;
  }
  return retained;
}

export class LocalProjectCheckpointRepository {
  constructor(private readonly storage?: Storage) {}
  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  /**
   * One validated decode of the whole document per operation. A malformed document, a wrong root
   * type (for example an array where a keyed object is required) or an unusable checkpoint fails the
   * read; the stored value is never replaced with an empty structure.
   */
  private read(): Record<string, AgentCheckpoint> {
    return readPersistedKeyedObject({
      repository: 'project worker checkpoints',
      storageKey,
      raw: this.store.getItem(storageKey),
      decode: (_runId, value) => (validateAgentCheckpoint(value) ? value : null),
    });
  }

  async get(runId: string): Promise<AgentCheckpoint | null> {
    const checkpoint = this.read()[runId];
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async save(runId: string, checkpoint: AgentCheckpoint): Promise<void> {
    if (!runId.trim() || !validateAgentCheckpoint(checkpoint))
      throw new Error('Cannot save an unsafe worker checkpoint.');
    await withStorageWrite(this.store, async () => {
      const records = this.read();
      records[runId] = checkpoint;
      const rawRuns = this.store.getItem(runStorageKey);
      const runs = await new LocalProjectTaskRunRepository(this.storage).list();
      const retained = retainCheckpoints({
        records,
        runs,
        hasRunDocument: rawRuns !== null,
        limit: checkpointLimit,
      });
      this.store.setItem(storageKey, JSON.stringify(retained));
    });
  }
}

export const projectCheckpointRepository = createDesktopRepository(
  (storage) => new LocalProjectCheckpointRepository(storage),
  [storageKey, runStorageKey],
);
