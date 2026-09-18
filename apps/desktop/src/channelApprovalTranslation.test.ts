import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool, ToolApprovalRequest } from '@iris/tools';
import { GatedToolExecutor, StaticPermissionEngine, ToolRegistry } from '@iris/tools';
import { LocalToolApprovalRepository } from './persistence';
import { SnapshotStorage } from './repositoryStorage';

/**
 * Phase 2I.4 regression suite — remote approval result translation.
 *
 * The defect this pins: only the tool-executor branch translated a lost-race error. A failure in
 * the agent branch or the project branch propagated out of `resolveRemoteApproval`, the channel
 * handler threw, and the remote user saw a channel failure ("needs attention") for something the
 * durable record could describe exactly.
 *
 * The invariant under test is the one that matters to a remote operator: the **durable** approval
 * record and the **returned** message must agree. A lost race reads as already resolved, a refusal
 * that settled nothing reads as a deferral that settled nothing, and success reads as success only
 * after the durable compare-and-set actually won.
 *
 * The tool branch runs the real `GatedToolExecutor` over the real `LocalToolApprovalRepository`, so
 * "settled" is a real durable compare-and-set, not a simulation. The agent and project runtime
 * surfaces are injected because their central lifecycles are covered by their own suites.
 */

const repositories = vi.hoisted(() => ({ approvals: undefined as unknown }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));

vi.mock('./persistence', async () => {
  const { LocalToolApprovalRepository } = await vi.importActual<typeof import('./persistence')>(
    './persistence',
  );
  const approvals = new LocalToolApprovalRepository();
  repositories.approvals = approvals;
  return {
    toolApprovalRepository: approvals,
    permissionRuleRepository: { list: async () => [] },
  };
});

vi.mock('./tooling', () => ({
  createToolExecutor: () => {
    const registry = new ToolRegistry();
    registry.register(fixtureTool);
    return new GatedToolExecutor(
      registry,
      new StaticPermissionEngine(),
      repositories.approvals as LocalToolApprovalRepository,
    );
  },
}));

/** A real registered tool so the executor's approved invocation has something to run. */
const fixtureTool: RegisteredTool = {
  id: 'shell.exec',
  name: 'Shell execute',
  description: 'Fixture tool for the approval translation suite.',
  risk: 'execute',
  providerName: 'shell_exec',
  manualExecution: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  async run() {
    return { stdout: 'translation-fixture-output' };
  },
};

const surfaces = vi.hoisted(() => ({
  suspendedForApproval: vi.fn(),
  resolveAgentApproval: vi.fn(),
  projectSuspendedForApproval: vi.fn(),
  projectResolveApproval: vi.fn(),
}));

vi.mock('./agentRuntime', () => ({
  agentRuntime: { suspendedForApproval: surfaces.suspendedForApproval },
}));
vi.mock('./agentApproval', () => ({ resolveAgentApproval: surfaces.resolveAgentApproval }));
vi.mock('./projectRuntime', () => ({
  projectWorkflowRuntime: {
    suspendedForApproval: surfaces.projectSuspendedForApproval,
    resolveApproval: surfaces.projectResolveApproval,
  },
}));

const APPROVAL_ID = 'approval-translation';

function approval(status: ToolApprovalRequest['status'] = 'pending'): ToolApprovalRequest {
  return {
    id: APPROVAL_ID,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    status,
    agentId: 'agent-translation',
    agentName: 'IRIS',
    toolId: 'shell.exec',
    toolName: 'Shell execute',
    input: { command: 'echo translation-fixture', isolation: 'host' },
    evaluation: { decision: 'ask', reason: 'Ask before running a host command.' },
    invocation: {},
  };
}

async function repository() {
  await import('./channelApprovals');
  return repositories.approvals as LocalToolApprovalRepository;
}

async function approve() {
  const { resolveRemoteApproval } = await import('./channelApprovals');
  return resolveRemoteApproval(`approve ${APPROVAL_ID}`);
}

beforeEach(async () => {
  vi.resetModules();
  // The repository reads `globalThis.localStorage` when a method is called, so the storage stub
  // must be in place before the first durable read of a test.
  vi.stubGlobal('localStorage', new SnapshotStorage());
  const repo = await repository();
  await repo.save(approval());
  surfaces.suspendedForApproval.mockReset().mockResolvedValue(null);
  surfaces.resolveAgentApproval.mockReset();
  surfaces.projectSuspendedForApproval.mockReset().mockResolvedValue(null);
  surfaces.projectResolveApproval.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('remote approval translation agrees with the durable record', () => {
  it('does not resolve anything when the approval id is unknown', async () => {
    const { resolveRemoteApproval } = await import('./channelApprovals');
    const message = await resolveRemoteApproval('approve approval-does-not-exist');
    expect(message).toBe('That approval is unavailable or already resolved.');
    expect(surfaces.resolveAgentApproval).not.toHaveBeenCalled();
    expect(surfaces.projectResolveApproval).not.toHaveBeenCalled();
  });

  it('reports an already-resolved approval without settling or resuming a second time', async () => {
    const repo = await repository();
    await repo.save(approval('completed'));
    const message = await approve();
    expect(message).toBe('That approval is unavailable or already resolved.');
    expect(surfaces.resolveAgentApproval).not.toHaveBeenCalled();
    expect(surfaces.projectResolveApproval).not.toHaveBeenCalled();
    // The terminal record is untouched: resolving twice cannot rewrite durable truth.
    expect((await repo.get(APPROVAL_ID))?.status).toBe('completed');
  });

  it('settles a pending approval through the real executor and reports the durable outcome', async () => {
    const repo = await repository();
    const message = await approve();
    expect(message).toContain('Approval approved and the tool invocation completed.');
    expect(message).toContain('echo translation-fixture');
    // Reported success must correspond to a terminal durable record, not to a hopeful message.
    expect((await repo.get(APPROVAL_ID))?.status).toBe('completed');
  });

  it('reports a lost duplicate settlement as already resolved, never as a failure', async () => {
    const repo = await repository();
    // Settle it out from under the channel delivery: this is the durable compare-and-set race.
    await repo.compareAndSet(APPROVAL_ID, 'pending', approval('approved'));
    const message = await approve();
    // The pre-check or the executor's compareAndSet loses; both report the same truth.
    expect(message).toBe('That approval is unavailable or already resolved.');
    expect((await repo.get(APPROVAL_ID))?.status).toBe('approved');
  });

  it('reports a controlled refusal from the agent branch as unsettled, never as a channel failure', async () => {
    const repo = await repository();
    surfaces.suspendedForApproval.mockResolvedValue({
      approvalId: APPROVAL_ID,
      agentId: 'agent-translation',
    });
    // The coordination layer throws a plain Error when this runtime does not hold the suspended turn.
    surfaces.resolveAgentApproval.mockRejectedValue(
      new Error(`No pending tool approval matches ${APPROVAL_ID}.`),
    );
    const message = await approve();
    expect(message).toContain('nothing was settled');
    expect(message).toContain('still pending');
    expect(message).not.toContain('approved for the active agent turn');
    // Nothing was settled, so the durable record is still pending.
    expect((await repo.get(APPROVAL_ID))?.status).toBe('pending');
  });

  it('reports a foreign-owned project resume as a deferral that settled nothing', async () => {
    const repo = await repository();
    surfaces.projectSuspendedForApproval.mockResolvedValue({
      id: 'run-translation',
      agentId: 'agent-translation',
    });
    const { ProjectWorkerBusyError } = await import('@iris/workflows');
    surfaces.projectResolveApproval.mockRejectedValue(
      new ProjectWorkerBusyError('agent-translation', 'project-run:run-translation'),
    );
    const message = await approve();
    expect(message).toContain('was not applied');
    expect(message).toContain('deferred');
    expect(message).toContain('still pending');
    expect(message).not.toContain('approved for the project worker');
    // Settlement was refused: the approval is untouched and the resume happened once.
    expect((await repo.get(APPROVAL_ID))?.status).toBe('pending');
    expect(surfaces.projectResolveApproval).toHaveBeenCalledTimes(1);
  });

  it('reports an unexpected project failure truthfully from the durable record', async () => {
    const repo = await repository();
    surfaces.projectSuspendedForApproval.mockResolvedValue({
      id: 'run-translation',
      agentId: 'agent-translation',
    });
    surfaces.projectResolveApproval.mockRejectedValue(new Error('Project worker storage failed.'));
    const message = await approve();
    expect(message).toContain('nothing was settled');
    expect(message).toContain('still pending');
    expect((await repo.get(APPROVAL_ID))?.status).toBe('pending');
  });

  it('reports an agent settlement that succeeded before a later failure as already resolved', async () => {
    const repo = await repository();
    surfaces.suspendedForApproval.mockResolvedValue({
      approvalId: APPROVAL_ID,
      agentId: 'agent-translation',
    });
    surfaces.resolveAgentApproval.mockImplementation(async () => {
      // The durable compare-and-set won, then a later step failed.
      await repo.compareAndSet(APPROVAL_ID, 'pending', approval('completed'));
      throw new Error('The resumed turn failed after settlement.');
    });
    const message = await approve();
    // Never "approved" for a settlement that did not happen, and never a channel failure for one
    // that did: the durable record decides which sentence is true.
    expect(message).toBe('That approval is unavailable or already resolved.');
    expect((await repo.get(APPROVAL_ID))?.status).toBe('completed');
  });

  it('never returns a success message for a branch that settled nothing', async () => {
    const repo = await repository();
    const failures: { name: string; arm: () => void }[] = [
      {
        name: 'agent branch',
        arm: () => {
          surfaces.suspendedForApproval.mockResolvedValue({ approvalId: APPROVAL_ID, agentId: 'a' });
          surfaces.resolveAgentApproval.mockRejectedValue(new Error('unowned suspended turn'));
        },
      },
      {
        name: 'project branch',
        arm: () => {
          surfaces.projectSuspendedForApproval.mockResolvedValue({ id: 'run', agentId: 'a' });
          surfaces.projectResolveApproval.mockRejectedValue(new Error('project failure'));
        },
      },
    ];
    for (const failure of failures) {
      const before = await repo.get(APPROVAL_ID);
      expect(before?.status, failure.name).toBe('pending');
      failure.arm();
      const message = await approve();
      expect(message, failure.name).toBeDefined();
      expect(message, failure.name).not.toMatch(
        /approved for the (active agent turn|project worker)/,
      );
      expect((await repo.get(APPROVAL_ID))?.status, failure.name).toBe('pending');
    }
  });
});
