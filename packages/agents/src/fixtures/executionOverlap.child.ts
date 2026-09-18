import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessLiveness } from '../leaseAuthority';

/**
 * Phase 2H.1 reproduction child. One child = one IRIS-like process: its own module-local
 * AgentExecutionLeaseRegistry (the production agentExecution.ts topology), the production
 * AgentRuntimeCoordinator admission path, and the shared SQLite repository fixture. The
 * blocking fake provider records PID, agent id and enter/exit instants as evidence.
 */

const role = process.env.IRIS_OVERLAP_ROLE ?? '';
const stage = process.env.IRIS_OVERLAP_STAGE ?? '';
const dbPath = process.env.IRIS_OVERLAP_DB ?? '';
const agentId = process.env.IRIS_OVERLAP_AGENT ?? 'agent';
if (!role || !stage || !dbPath) throw new Error('Overlap child requires stage environment.');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(path: string): Promise<void> {
  while (!existsSync(path)) await sleep(5);
}

const evidence = join(stage, `${role}.jsonl`);
let attempt = 'initial';
function record(event: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(
    evidence,
    `${JSON.stringify({
      pid: process.pid,
      role,
      agentId,
      event,
      attempt,
      t: Number(process.hrtime.bigint() / 1000000n),
      ...extra,
    })}\n`,
  );
}

let entered = false;
let probeMode: 'native' | 'unknown' | 'throw' = 'native';
const provider = {
  definition: {
    id: 'overlap-fake',
    name: 'Overlap fake',
    kind: 'test' as const,
    capabilities: ['chat' as import('@iris/core').Capability],
    local: true,
  },
  capabilities: (): import('@iris/core').Capability[] => ['chat'],
  testConnection: async () => undefined,
  stream: async function* () {
    entered = true;
    record('enter');
    await waitFor(join(stage, `${role}.release`));
    record('exit');
    yield { text: 'Done.', done: true };
  },
};

const { AgentRuntimeCoordinator, AgentExecutionLeaseRegistry } = await import('../index');
const { openOverlapRepository } = await import('./executionOverlap.repository');
const { createLeaseAuthority } = await import('../leaseAuthority');

const repositories = openOverlapRepository(dbPath);
const leases = new AgentExecutionLeaseRegistry();
// Phase 2H.1: the cross-process authority that production wires into every coordinator.
// IRIS_OVERLAP_DISABLE_LEASE=1 reproduces the pre-fix vulnerability on the fixed tree.
const instance = randomUUID();
const crossProcess = process.env.IRIS_OVERLAP_DISABLE_LEASE
  ? undefined
  : createLeaseAuthority(repositories.transactions, {
    pid: async () => process.pid,
    instance: () => instance,
    liveness: async (pid): Promise<ProcessLiveness> => {
      if (probeMode === 'throw') {
        record('probe', { candidate: pid, mode: probeMode });
        throw new Error('Injected liveness transport failure.');
      }
      let result: ProcessLiveness;
      if (probeMode === 'unknown') {
        result = { status: 'unknown', reason: 'Injected inconclusive liveness probe.' };
      } else {
        try {
          process.kill(pid, 0);
          result = { status: 'alive' };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          result = code === 'EPERM'
            ? { status: 'alive' }
            : code === 'ESRCH'
              ? { status: 'dead' }
              : { status: 'unknown', reason: code ?? 'Process probe failed.' };
        }
      }
      record('probe', { candidate: pid, mode: probeMode, status: result.status });
      return result;
    },
  });
const ownerKind = role === 'scheduled' ? ('scheduled' as const) : ('interactive' as const);
const runtime = new AgentRuntimeCoordinator(
  repositories.agents,
  repositories.conversations,
  repositories.suspended,
  { resolve: async () => ({ provider, model: 'overlap-model' }) },
  {
    definitions: () => [],
    execute: async () => ({ status: 'completed', output: null }),
    resolve: async () => ({ status: 'completed', output: null }),
  },
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    leases,
    ownerKind,
    ownerId: (id: string) => `${ownerKind}:${id}`,
    crossProcess,
  },
);

// Hard watchdog: the harness parent may die before releasing the barrier. A child that can
// never reach its release gate must terminate instead of holding shared state forever.
setTimeout(() => {
  record('watchdog-timeout');
  process.exit(2);
}, 30000).unref();
// The scheduled child seeds the shared agent configuration before signalling ready, so both
// children start from the same persisted state without embedding agent data in the harness.
if (role === 'scheduled') await repositories.agents.save({
  id: agentId, name: 'Overlap agent', autonomy: 'assist', skillIds: [], toolIds: [],
});
writeFileSync(join(stage, `${role}.ready`), String(process.pid));

async function runTurn(): Promise<number> {
  entered = false;
  try {
    for await (const event of runtime.send(agentId, 'Overlap probe')) {
      if (event.type === 'tool-failed') throw new Error('Turn failed.');
    }
    record(entered ? 'completed' : 'never-entered');
    return 0;
  } catch (error) {
    record('error', { message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

if (role === 'interactive' && process.env.IRIS_OVERLAP_PROBE_FAILURES === '1') {
  // The same real process and coordinator retry each admission; no synthetic dead PID or
  // replacement coordinator can hide a leaked local reservation after a denied probe.
  for (const mode of ['unknown', 'throw', 'native'] as const) {
    attempt = mode;
    await waitFor(join(stage, `${role}.${mode}.start`));
    probeMode = mode;
    const code = await runTurn();
    writeFileSync(join(stage, `${role}.${mode}.done`), String(code));
  }
  process.exit(0);
} else {
  await waitFor(join(stage, `${role}.start`));
  process.exit(await runTurn());
}
