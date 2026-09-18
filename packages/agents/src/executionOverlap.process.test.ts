import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { agentLeaseStorageKey, decodeExecutionLeases } from './leaseAuthority';

/**
 * IRIS Phase 2H.1 — two real OS processes, the production AgentRuntimeCoordinator admission
 * path in each, each with its own module-local AgentExecutionLeaseRegistry (the production
 * agentExecution.ts topology), one shared SQLite repository, and a deterministic blocking
 * fake provider. Evidence: PID, agent id, execution intervals, per-process errors.
 *
 * Before the cross-process lease authority both processes entered the provider for the same
 * agent (the recorded pre-fix evidence). With the authority wired, exactly one process may
 * execute the agent; the loser is refused with a truthful busy error and never streams.
 */

const here = import.meta.dirname ?? '';
const esbuild = '/mnt/ai/IRIS/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await sleep(5);
  }
}

interface Interval {
  pid: number;
  role: string;
  agentId: string;
  enter: number;
  exit: number | null;
}

interface Evidence {
  intervals: Interval[];
  errors: { role: string; event: string; message?: string }[];
}

function readEvidence(stage: string): Evidence {
  const intervals: Interval[] = [];
  const errors: Evidence['errors'] = [];
  for (const role of ['scheduled', 'interactive']) {
    const path = join(stage, `${role}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as {
        pid: number;
        role: string;
        agentId: string;
        event: string;
        t: number;
        message?: string;
      };
      if (entry.event === 'enter')
        intervals.push({ pid: entry.pid, role: entry.role, agentId: entry.agentId, enter: entry.t, exit: null });
      if (entry.event === 'exit' && intervals.at(-1)?.role === role)
        intervals.at(-1)!.exit = entry.t;
      if (entry.event === 'error' || entry.event === 'never-entered')
        errors.push({ role: entry.role, event: entry.event, message: entry.message });
    }
  }
  return { intervals, errors };
}

function waitExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function buildChild(stage: string): string {
  const bundle = join(stage, 'child.mjs');
  const build = spawnSync(
    process.execPath,
    [
      esbuild,
      '--bundle',
      join(here, 'fixtures/executionOverlap.child.ts'),
      '--platform=node',
      '--format=esm',
      `--outfile=${bundle}`,
      '--external:node:sqlite',
      '--log-level=warning',
    ],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`esbuild failed: ${build.stderr}`);
  return bundle;
}

async function runOverlap(options: { disableLease?: boolean } = {}): Promise<Evidence> {
  const stage = mkdtempSync(join(tmpdir(), 'iris-overlap-'));
  const bundle = buildChild(stage);
  const env = {
    ...process.env,
    IRIS_OVERLAP_DB: join(stage, 'repository.sqlite'),
    IRIS_OVERLAP_STAGE: stage,
    IRIS_OVERLAP_AGENT: 'agent',
    ...(options.disableLease ? { IRIS_OVERLAP_DISABLE_LEASE: '1' } : {}),
  };
  const first = spawn(process.execPath, [bundle], {
    env: { ...env, IRIS_OVERLAP_ROLE: 'scheduled' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // Attach exit listeners immediately: the refused process terminates at admission time,
  // long before the release barriers, so a later listener would miss the exit event.
  const exit1Promise = waitExit(first);
  await waitForFile(join(stage, 'scheduled.ready'));
  const second = spawn(process.execPath, [bundle], {
    env: { ...env, IRIS_OVERLAP_ROLE: 'interactive' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exit2Promise = waitExit(second);
  await waitForFile(join(stage, 'interactive.ready'));
  // Both children may proceed; the lease authority decides which one executes.
  writeFileSync(join(stage, 'scheduled.start'), '1');
  writeFileSync(join(stage, 'interactive.start'), '1');
  // Give both admissions time to reach their decision before any release.
  const deadline = Date.now() + 30000;
  const enteredOnce = () => readEvidence(stage).intervals.length >= 1;
  while (!enteredOnce() && Date.now() < deadline) await sleep(5);
  await sleep(50);
  writeFileSync(join(stage, 'scheduled.release'), '1');
  writeFileSync(join(stage, 'interactive.release'), '1');
  const evidence = readEvidence(stage);
  const [exit1, exit2] = await Promise.all([exit1Promise, exit2Promise]);
  if (exit1.code !== 0 && exit1.code !== null)
    evidence.errors.push({ role: 'scheduled', event: 'exit', message: `exit ${exit1.code}` });
  if (exit2.code !== 0 && exit2.code !== null)
    evidence.errors.push({ role: 'interactive', event: 'exit', message: `exit ${exit2.code}` });
  return evidence;
}

interface ChildEvent {
  pid: number;
  event: string;
  attempt: string;
  candidate?: number;
  mode?: string;
  status?: string;
  message?: string;
}

function childEvents(stage: string, role: string): ChildEvent[] {
  const path = join(stage, `${role}.jsonl`);
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ChildEvent)
    : [];
}

async function waitForEvent(stage: string, role: string, event: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!childEvents(stage, role).some((entry) => entry.event === event)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${role}: ${event}`);
    await sleep(5);
  }
}

function leaseSnapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT value,revision FROM documents WHERE key=?').get(agentLeaseStorageKey);
    const value = row?.value === undefined || row.value === null ? null : String(row.value);
    return { value, revision: Number(row?.revision ?? 0), leases: decodeExecutionLeases(value) };
  } finally {
    db.close();
  }
}

function overlapCount(intervals: Interval[]): number {
  let count = 0;
  for (let i = 0; i < intervals.length; i++)
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]!;
      const b = intervals[j]!;
      if (a.pid === b.pid) continue;
      if (
        Math.min(a.exit ?? Number.POSITIVE_INFINITY, b.exit ?? Number.POSITIVE_INFINITY) >
        Math.max(a.enter, b.enter)
      )
        count++;
    }
  return count;
}

describe('Phase 2H.3 uncertain process liveness', () => {
  it('retains live A on unknown and thrown B probes, then recovers only after A is killed', { timeout: 60000 }, async () => {
    const stage = mkdtempSync(join(tmpdir(), 'iris-overlap-liveness-'));
    const bundle = buildChild(stage);
    const dbPath = join(stage, 'repository.sqlite');
    const env = {
      ...process.env,
      IRIS_OVERLAP_DB: dbPath,
      IRIS_OVERLAP_STAGE: stage,
      IRIS_OVERLAP_AGENT: 'agent-X',
      IRIS_OVERLAP_PROBE_FAILURES: '1',
    };
    const first = spawn(process.execPath, [bundle], {
      env: { ...env, IRIS_OVERLAP_ROLE: 'scheduled' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exit1 = waitExit(first);
    let second: ReturnType<typeof spawn> | undefined;
    let exit2: ReturnType<typeof waitExit> | undefined;
    try {
      await waitForFile(join(stage, 'scheduled.ready'));
      writeFileSync(join(stage, 'scheduled.start'), '1');
      await waitForEvent(stage, 'scheduled', 'enter');
      const held = leaseSnapshot(dbPath);
      expect(held.revision).toBe(1);
      expect(held.leases['agent-X']).toMatchObject({
        processId: first.pid,
        ownerId: 'scheduled:agent-X',
      });
      expect(held.leases['agent-X']?.processInstance).toBeTruthy();

      second = spawn(process.execPath, [bundle], {
        env: { ...env, IRIS_OVERLAP_ROLE: 'interactive' },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      exit2 = waitExit(second);
      await waitForFile(join(stage, 'interactive.ready'));
      expect(second.pid).not.toBe(first.pid);
      for (const mode of ['unknown', 'throw'] as const) {
        writeFileSync(join(stage, `interactive.${mode}.start`), '1');
        await waitForFile(join(stage, `interactive.${mode}.done`));
        expect(readFileSync(join(stage, `interactive.${mode}.done`), 'utf8')).toBe('1');
        const events = childEvents(stage, 'interactive');
        expect(events.filter((event) => event.attempt === mode && event.event === 'probe')).toContainEqual(
          expect.objectContaining({ candidate: first.pid, mode, ...(mode === 'unknown' ? { status: 'unknown' } : {}) }),
        );
        expect(events.filter((event) => event.attempt === mode && event.event === 'error')).toEqual([
          expect.objectContaining({ message: expect.stringMatching(/another IRIS process/) }),
        ]);
        expect(events.some((event) => event.event === 'enter')).toBe(false);
        // Denial is not a lease write: preserve the exact document and revision, not merely
        // the owner id. Check A is genuinely still alive and blocked inside its provider.
        expect(leaseSnapshot(dbPath)).toEqual(held);
        expect(first.exitCode).toBeNull();
        expect(first.signalCode).toBeNull();
        expect(() => process.kill(first.pid!, 0)).not.toThrow();
        expect(childEvents(stage, 'scheduled').some((event) => event.event === 'exit')).toBe(false);
      }

      expect(first.kill('SIGKILL')).toBe(true);
      expect(await exit1).toEqual({ code: null, signal: 'SIGKILL' });
      expect(leaseSnapshot(dbPath)).toEqual(held);
      // Only now remove the injected fault. B's real OS probe must observe ESRCH and
      // recover A's stale record; no fixture release or fabricated dead PID is involved.
      writeFileSync(join(stage, 'interactive.native.start'), '1');
      await waitForEvent(stage, 'interactive', 'enter');
      const recovered = leaseSnapshot(dbPath);
      expect(recovered.revision).toBe(held.revision + 1);
      expect(recovered.leases['agent-X']).toMatchObject({
        processId: second.pid,
        ownerId: 'interactive:agent-X',
      });
      expect(recovered.leases['agent-X']?.processInstance).not.toBe(held.leases['agent-X']?.processInstance);
      expect(childEvents(stage, 'interactive')).toContainEqual(expect.objectContaining({
        event: 'probe', candidate: first.pid, mode: 'native', status: 'dead',
      }));
      writeFileSync(join(stage, 'interactive.release'), '1');
      await waitForFile(join(stage, 'interactive.native.done'));
      expect(readFileSync(join(stage, 'interactive.native.done'), 'utf8')).toBe('0');
      expect(await exit2).toEqual({ code: 0, signal: null });
      expect(childEvents(stage, 'interactive').filter((event) => event.event === 'enter')).toEqual([
        expect.objectContaining({ pid: second.pid, attempt: 'native' }),
      ]);
      expect(childEvents(stage, 'interactive')).toContainEqual(expect.objectContaining({
        event: 'completed', attempt: 'native',
      }));
      const released = leaseSnapshot(dbPath);
      expect(released.revision).toBe(held.revision + 2);
      expect(released.leases).toEqual({});
    } finally {
      // Assertions and barrier timeouts must not leave real provider-holding processes alive.
      if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
      if (second && second.exitCode === null && second.signalCode === null) second.kill('SIGKILL');
      await Promise.all([exit1, ...(exit2 ? [exit2] : [])]);
    }
  });
});

describe('Phase 2H.1 cross-process execution ownership', () => {
  it('executes the same agent in exactly one of two real processes with the lease authority', { timeout: 60000 }, async () => {
    const { intervals, errors } = await runOverlap();
    // Exactly one process may enter execution for the shared agent.
    expect(overlapCount(intervals)).toBe(0);
    expect(intervals.length).toBe(1);
    expect(intervals[0]!.agentId).toBe('agent');
    // The refused process reports the truthful cross-process busy error and never enters.
    expect(errors.some((error) => error.event === 'error' && /another IRIS process/.test(error.message ?? ''))).toBe(true);
  });

  it('with the authority disabled the same agent still overlaps across processes (records the defect)', { timeout: 60000 }, async () => {
    // The recorded pre-fix vulnerability, permanently reproducible on the current tree: the
    // gated child runs the identical production admission path with only the cross-process
    // authority switched off. It fails the moment the local path alone stops admitting both
    // processes, and documents exactly why the authority is mandatory.
    const { intervals, errors } = await runOverlap({ disableLease: true });
    expect(errors).toEqual([]);
    expect(new Set(intervals.map((interval) => interval.pid)).size).toBe(2);
    expect(intervals.length).toBe(2);
    expect(overlapCount(intervals)).toBeGreaterThanOrEqual(1);
  });
});
