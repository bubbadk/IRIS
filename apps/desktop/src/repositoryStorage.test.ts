import { LocalKnowledgeRepository } from './knowledge';
import { LocalDocumentRepository } from './documents';
import { describe, expect, it } from 'vitest';
import {
  RepositoryTransactions,
  type RepositoryBackend,
  type StorageSnapshot,
} from './repositoryStorage';
import {
  LocalConversationRepository,
  LocalToolApprovalRepository,
  LocalProjectGraphRepository,
  LocalProjectQueueRepository,
  LocalProjectTaskRunRepository,
  LocalProjectRunCommitter,
} from './persistence';
import {
  projectTaskVersion,
  projectResultVersion,
  type QualityReviewReceipt,
  addProjectTask,
  createProjectGraph,
  projectTaskState,
  type ProjectTaskRun,
} from '@iris/workflows';
import type { ToolApprovalRequest } from '@iris/tools';

class TestDatabase implements RepositoryBackend {
  data: StorageSnapshot = { values: {}, revisions: {} };
  fail = false;
  async snapshot() {
    return structuredClone(this.data);
  }
  async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
    if (this.fail) throw new Error('Disk full');
    if (
      Object.entries(expected).some(
        ([key, revision]) => (this.data.revisions[key] ?? 0) !== revision,
      )
    )
      return false;
    for (const [key, value] of Object.entries(changes)) {
      this.data.revisions[key] = (this.data.revisions[key] ?? 0) + 1;
      if (value === null) delete this.data.values[key];
      else this.data.values[key] = value;
    }
    return true;
  }
}

describe('native repository transaction adapter', () => {
  it('atomically reserves one queued project task across competing windows', async () => {
    const database = new TestDatabase();
    const first = new RepositoryTransactions(database);
    const second = new RepositoryTransactions(database);
    const at = '2026-09-09T12:00:00.000Z';
    await first.run((storage) =>
      new LocalProjectQueueRepository(storage).enqueue({
        version: 1,
        id: 'queue-entry',
        projectId: 'project',
        taskId: 'task',
        agentId: 'agent',
        status: 'queued',
        queuedAt: at,
        updatedAt: at,
      }),
    );
    const claims = await Promise.all(
      [first, second].map((view) =>
        view.run((storage) => new LocalProjectQueueRepository(storage).claim('queue-entry', at)),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await new RepositoryTransactions(database).run((storage) =>
        new LocalProjectQueueRepository(storage).get('queue-entry'),
      ),
    ).toMatchObject({ status: 'claimed', claimedAt: at });
  });
  it('retains both agents when two webviews save conversations concurrently', async () => {
    const database = new TestDatabase();
    const windows = [new RepositoryTransactions(database), new RepositoryTransactions(database)];
    await Promise.all(
      windows.map((view, index) =>
        view.run(async (storage) => {
          const repository = new LocalConversationRepository(storage);
          await repository.save(String(index), [{ role: 'user', content: `Message ${index}` }]);
        }),
      ),
    );
    const reopened = new RepositoryTransactions(database);
    const messages = await Promise.all(
      ['0', '1'].map((id) =>
        reopened.run((storage) => new LocalConversationRepository(storage).list(id)),
      ),
    );
    expect(messages.map((history) => history[0]?.content)).toEqual(['Message 0', 'Message 1']);
  });
  it('re-evaluates approval state after a competing window commits', async () => {
    const database = new TestDatabase();
    const first = new RepositoryTransactions(database);
    const second = new RepositoryTransactions(database);
    const approval: ToolApprovalRequest = {
      id: 'a',
      agentId: 'agent',
      agentName: 'Agent',
      toolId: 'test',
      toolName: 'Test',
      input: {},
      evaluation: { decision: 'ask', reason: 'Ask' },
      status: 'approved',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    await first.run((storage) => new LocalToolApprovalRepository(storage).save(approval));
    const claims = await Promise.all(
      [first, second].map((view) =>
        view.run((storage) =>
          new LocalToolApprovalRepository(storage).compareAndSet('a', 'approved', {
            ...approval,
            status: 'executing',
          }),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    // A restart cannot claim an invocation already marked executing.
    expect(
      await new RepositoryTransactions(database).run((storage) =>
        new LocalToolApprovalRepository(storage).compareAndSet('a', 'approved', {
          ...approval,
          status: 'executing',
        }),
      ),
    ).toBe(false);
  });
  it('does not expose an uncommitted write after storage failure', async () => {
    const database = new TestDatabase();
    const view = new RepositoryTransactions(database);
    await view.initialize();
    database.fail = true;
    await expect(
      view.run(async (storage) => {
        storage.setItem('iris.memory.records.v1', '[1]');
      }),
    ).rejects.toThrow('Disk full');
    expect(view.initialSnapshot.getItem('iris.memory.records.v1')).toBeNull();
    expect(database.data.values).toEqual({});
  });
  it.each([false, true])(
    'atomically saves human verification and dependency progress, including after restart (checks: %s)',
    async (withChecks) => {
      const database = new TestDatabase();
      const view = new RepositoryTransactions(database);
      const at = '2026-09-07T10:00:00.000Z';
      let graph = createProjectGraph({
        id: 'p',
        title: 'Feature',
        objective: 'Working feature',
        createdAt: at,
      });
      graph = addProjectTask(graph, {
        id: 't',
        title: 'Build',
        acceptanceCriteria: 'Tests pass',
        createdAt: at,
      });
      graph = addProjectTask(graph, {
        id: 'next',
        title: 'Review integration',
        dependencyIds: ['t'],
        createdAt: at,
      });
      const run: ProjectTaskRun = {
        version: 1,
        id: 'r',
        projectId: 'p',
        taskId: 't',
        agentId: 'a',
        agentName: 'Worker',
        status: 'awaiting-review',
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        returnedAt: at,
        runtimeTurnId: 'turn',
        output: 'Build report',
        acceptanceCriteria: 'Tests pass',
      };
      if (withChecks) {
        run.resultChecks = [
          { id: 'check', target: { kind: 'document', title: 'Report' }, assertion: 'nonempty' },
        ];
        graph.tasks[0]!.resultChecks = structuredClone(run.resultChecks);
        run.checkReports = [
          {
            runtimeTurnId: 'turn',
            checkedAt: at,
            results: [
              {
                checkId: 'check',
                status: 'passed',
                message: 'Non-empty text confirmed.',
                evidence: 'revision-1',
              },
            ],
          },
        ];
      }
      run.qualityReviews = [
        {
          id: 'coverage',
          method: 'human-review',
          reviewedAt: at,
          projectId: run.projectId,
          taskId: run.taskId,
          runId: run.id,
          criteriaVersion: run.acceptanceCriteria!,
          taskVersion: projectTaskVersion(graph.tasks[0]!),
          resultVersion: projectResultVersion(run),
          checkReport: structuredClone(run.checkReports?.[0]),
          assessments: [
            {
              criterion: 0,
              outcome: 'met',
              rationale: 'Inspected test output.',
              evidence: 'Controlled fixture output: tests pass.',
            },
          ],
          findings: [],
          resolutions: [],
        },
      ];
      const evidence = {
        expectedRun: structuredClone(run),
        checkReport: structuredClone(run.checkReports?.[0]),
      };
      await view.run(async (storage) => {
        await new LocalProjectGraphRepository(storage).save(graph);
        await new LocalProjectTaskRunRepository(storage).save(run);
      });
      database.fail = true;
      await expect(
        view.run((storage) =>
          new LocalProjectRunCommitter(storage).verify('r', 'Test output checked.', at, evidence),
        ),
      ).rejects.toThrow('Disk full');
      database.fail = false;
      const reopened = new RepositoryTransactions(database);
      const pending = await reopened.run((storage) =>
        new LocalProjectTaskRunRepository(storage).get('r'),
      );
      expect(pending?.status).toBe('awaiting-review');
      expect(pending?.verification).toBeUndefined();
      const untouched = await reopened.run((storage) =>
        new LocalProjectGraphRepository(storage).get('p'),
      );
      expect(projectTaskState(untouched!, 'next')).toBe('blocked');
      const reviews = await Promise.allSettled(
        [view, reopened].map((window) =>
          window.run((storage) =>
            new LocalProjectRunCommitter(storage).verify('r', 'Test output checked.', at, evidence),
          ),
        ),
      );
      expect(reviews.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const final = await new RepositoryTransactions(database).run(async (storage) => ({
        graph: await new LocalProjectGraphRepository(storage).get('p'),
        run: await new LocalProjectTaskRunRepository(storage).get('r'),
      }));
      expect(projectTaskState(final.graph!, 'next')).toBe('ready');
      expect(final.run?.verification?.note).toBe('Test output checked.');
      expect(final.run?.verification?.checkReport).toEqual(evidence.checkReport);
    },
  );
  it('allows either review or a new run across competing windows, never both', async () => {
    const database = new TestDatabase();
    const first = new RepositoryTransactions(database);
    const second = new RepositoryTransactions(database);
    const at = '2026-09-07T10:00:00.000Z';
    const graph = addProjectTask(
      createProjectGraph({ id: 'p', title: 'Project', objective: 'Test', createdAt: at }),
      { id: 't', title: 'Task', createdAt: at },
    );
    const report: ProjectTaskRun = {
      version: 1,
      id: 'old',
      projectId: 'p',
      taskId: 't',
      agentId: 'a',
      agentName: 'Worker',
      status: 'awaiting-review',
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      returnedAt: at,
      runtimeTurnId: 'turn',
      output: 'Report',
    };
    await first.run(async (storage) => {
      await new LocalProjectGraphRepository(storage).save(graph);
      await new LocalProjectTaskRunRepository(storage).save(report);
    });
    const next: ProjectTaskRun = {
      version: 1,
      id: 'new',
      projectId: 'p',
      taskId: 't',
      agentId: 'a',
      agentName: 'Worker',
      status: 'queued',
      createdAt: '2026-09-07T10:01:00.000Z',
      updatedAt: '2026-09-07T10:01:00.000Z',
      previousRunId: 'old',
    };
    const results = await Promise.allSettled([
      first.run((storage) => new LocalProjectRunCommitter(storage).reserve(next)),
      second.run((storage) =>
        new LocalProjectRunCommitter(storage).verify('old', 'Checked report.', at),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const final = await first.run(async (storage) => ({
      graph: await new LocalProjectGraphRepository(storage).get('p'),
      next: await new LocalProjectTaskRunRepository(storage).get('new'),
    }));
    expect(Boolean(final.graph?.tasks[0]?.completedAt)).toBe(!final.next);
  });
  it('claims a paused run only once across two windows and preserves concurrent pause requests', async () => {
    const database = new TestDatabase();
    const first = new RepositoryTransactions(database);
    const second = new RepositoryTransactions(database);
    const at = '2026-09-07T10:00:00.000Z';
    const graph = addProjectTask(
      createProjectGraph({ id: 'p', title: 'Project', objective: 'Test', createdAt: at }),
      { id: 't', title: 'Task', turnLimit: 3, createdAt: at },
    );
    const paused: ProjectTaskRun = {
      version: 1,
      id: 'r',
      projectId: 'p',
      taskId: 't',
      agentId: 'a',
      agentName: 'Worker',
      status: 'paused',
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      returnedAt: at,
      pausedAt: at,
      pauseRequested: true,
      runtimeTurnId: 'turn',
      stopReason: 'tool-limit',
      turnLimit: 3,
      turnsUsed: 1,
      output: 'Progress.',
    };
    await first.run(async (storage) => {
      await new LocalProjectGraphRepository(storage).save(graph);
      await new LocalProjectTaskRunRepository(storage).save(paused);
    });
    const claims = await Promise.allSettled(
      [first, second].map((view) =>
        view.run((storage) => new LocalProjectRunCommitter(storage).resume('r', at)),
      ),
    );
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const resumed = await first.run((storage) =>
      new LocalProjectTaskRunRepository(storage).get('r'),
    );
    expect(resumed?.pauseRequested).toBe(false);
    await second.run((storage) => new LocalProjectRunCommitter(storage).pause('r', at));
    await first.run((storage) =>
      new LocalProjectTaskRunRepository(storage).save({ ...resumed!, turnsUsed: 2 }),
    );
    expect(
      (await second.run((storage) => new LocalProjectTaskRunRepository(storage).get('r')))
        ?.pauseRequested,
    ).toBe(true);
  });
});

describe('document repository contention', () => {
  it('allows one revision from competing editors and retains the original after restart', async () => {
    const database = new TestDatabase();
    const first = new RepositoryTransactions(database);
    const second = new RepositoryTransactions(database);
    const revision = {
      id: 'r1',
      content: 'Original',
      createdAt: '2026-09-08T10:00:00Z',
      author: { kind: 'user' as const, id: 'user', name: 'You' },
    };
    await first.run((storage) =>
      new LocalDocumentRepository(storage).create({
        id: 'doc',
        title: 'Report',
        format: 'text',
        revision,
      }),
    );
    const results = await Promise.allSettled(
      [first, second].map((view, index) =>
        view.run((storage) =>
          new LocalDocumentRepository(storage).revise('doc', 'r1', {
            ...revision,
            id: `next-${index}`,
            content: `Editor ${index}`,
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const saved = await new RepositoryTransactions(database).run((storage) =>
      new LocalDocumentRepository(storage).get('doc'),
    );
    expect(saved?.revisions).toHaveLength(2);
    expect(saved?.revisions[0].content).toBe('Original');
    database.fail = true;
    await expect(
      first.run((storage) =>
        new LocalDocumentRepository(storage).revise('doc', saved!.revisions[1].id, {
          ...revision,
          id: 'failed',
          content: 'Not saved',
        }),
      ),
    ).rejects.toThrow('Disk full');
    expect(
      JSON.parse(database.data.values['iris.documents.records.v1']!)[0].revisions,
    ).toHaveLength(2);
  });
});

describe('knowledge approval contention', () => {
  it('prevents simultaneous conflicting approvals and retains all proposals', async () => {
    const database = new TestDatabase();
    const windows = [new RepositoryTransactions(database), new RepositoryTransactions(database)];
    const at = '2026-09-08T10:00:00Z';
    for (const id of ['one', 'two'])
      await windows[0].run((storage) =>
        new LocalKnowledgeRepository(storage).propose({
          id,
          scope: { kind: 'global' },
          kind: 'preference',
          topic: 'Writing language',
          content: id,
          createdAt: at,
          provenance: { source: 'user', actorId: 'user', actorName: 'You', capturedAt: at },
        }),
      );
    const approvals = await Promise.allSettled(
      windows.map((view, index) =>
        view.run((storage) =>
          new LocalKnowledgeRepository(storage).review(index ? 'two' : 'one', 1, 'activate', {}),
        ),
      ),
    );
    expect(approvals.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const records = await new RepositoryTransactions(database).run((storage) =>
      new LocalKnowledgeRepository(storage).list(),
    );
    expect(records).toHaveLength(2);
    expect(records.filter((entry) => entry.status === 'active')).toHaveLength(1);
    database.fail = true;
    const active = records.find((entry) => entry.status === 'active')!;
    await expect(
      windows[0].run((storage) =>
        new LocalKnowledgeRepository(storage).review(active.id, active.revision, 'archive', {}),
      ),
    ).rejects.toThrow('Disk full');
    expect(
      JSON.parse(database.data.values['iris.knowledge.records.v1']!).find(
        (entry: { id: string }) => entry.id === active.id,
      ).status,
    ).toBe('active');
  });
});

it('atomically queues a scheduled occurrence and only one runtime claims it, with persistent pause', async () => {
  const { LocalScheduledQueue } = await import('./scheduledQueue');
  const { LocalScheduleRepository, LocalScheduledRunRepository } = await import('./persistence');
  const database = new TestDatabase();
  const first = new RepositoryTransactions(database);
  const second = new RepositoryTransactions(database);
  const at = '2026-09-09T10:00:00.000Z';
  const schedule = {
    version: 1 as const,
    id: 'queue-test',
    name: 'Queue test',
    agentId: 'agent',
    prompt: 'Original prompt',
    recurrence: 'once' as const,
    runAt: at,
    timeOfDay: '10:00',
    timeZone: 'UTC',
    enabled: true,
    createdAt: at,
    updatedAt: at,
    nextRunAt: at,
  };
  const run = {
    version: 1 as const,
    queueVersion: 1 as const,
    id: 'job',
    scheduleId: schedule.id,
    agentId: 'agent',
    prompt: schedule.prompt,
    status: 'queued' as const,
    scheduledFor: at,
    createdAt: at,
    updatedAt: at,
  };
  await first.run((storage) => new LocalScheduleRepository(storage).save(schedule));
  database.fail = true;
  await expect(
    first.run((storage) =>
      new LocalScheduledQueue(storage).enqueue(schedule, run, {
        ...schedule,
        enabled: false,
        nextRunAt: undefined,
      }),
    ),
  ).rejects.toThrow('Disk full');
  database.fail = false;
  expect(
    await first.run((storage) => new LocalScheduledRunRepository(storage).list()),
  ).toHaveLength(0);
  expect(
    (await first.run((storage) => new LocalScheduleRepository(storage).get(schedule.id)))?.enabled,
  ).toBe(true);
  const queued = await Promise.all(
    [first, second].map((view) =>
      view.run((storage) =>
        new LocalScheduledQueue(storage).enqueue(schedule, run, {
          ...schedule,
          enabled: false,
          nextRunAt: undefined,
        }),
      ),
    ),
  );
  expect(queued.filter(Boolean)).toHaveLength(1);
  expect(
    await first.run((storage) => new LocalScheduledRunRepository(storage).list()),
  ).toHaveLength(1);
  expect(
    (await first.run((storage) => new LocalScheduleRepository(storage).get(schedule.id)))?.enabled,
  ).toBe(false);
  await first.run((storage) => new LocalScheduledQueue(storage).setPaused(true));
  expect(
    await second.run((storage) => new LocalScheduledQueue(storage).claim('job', at, 'queued')),
  ).toBeNull();
  expect(await second.run((storage) => new LocalScheduledQueue(storage).isPaused())).toBe(true);
  await first.run((storage) => new LocalScheduledQueue(storage).setPaused(false));
  const claims = await Promise.all(
    [first, second].map((view) =>
      view.run((storage) => new LocalScheduledQueue(storage).claim('job', at, 'queued')),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims.find(Boolean)?.executionClaimedAt).toBe(at);
});

it('persists quality reviews and rejections atomically, rejects racing reviewers, and retains history across restart', async () => {
  const database = new TestDatabase();
  const view = new RepositoryTransactions(database);
  const at = '2026-09-11T10:00:00Z';
  const graph = addProjectTask(
    createProjectGraph({ id: 'p', title: 'Quality', objective: 'Reviewed output', createdAt: at }),
    { id: 't', title: 'Export', acceptanceCriteria: 'Opens correctly', createdAt: at },
  );
  const run: ProjectTaskRun = {
    version: 1,
    id: 'r',
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Controlled test worker',
    status: 'awaiting-review',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    returnedAt: at,
    runtimeTurnId: 'turn',
    output: 'Offline fixture.',
    acceptanceCriteria: 'Opens correctly',
  };
  await view.run(async (storage) => {
    await new LocalProjectGraphRepository(storage).save(graph);
    await new LocalProjectTaskRunRepository(storage).save(run);
  });
  const receipt: QualityReviewReceipt = {
    expectedRun: run,
    expectedTask: projectTaskVersion(graph.tasks[0]!),
    review: {
      id: 'review',
      method: 'human-review',
      reviewedAt: at,
      runId: 'r',
      projectId: 'p',
      taskId: 't',
      criteriaVersion: 'Opens correctly',
      taskVersion: projectTaskVersion(graph.tasks[0]!),
      resultVersion: projectResultVersion(run),
      assessments: [
        {
          criterion: 0,
          outcome: 'unmet',
          rationale: 'Open failed.',
          evidence: 'Export reader reported missing header.',
        },
      ],
      findings: [
        {
          id: 'finding',
          blocking: true,
          reason: 'Missing header.',
          repair: 'Add the required export header.',
        },
      ],
      resolutions: [],
    },
  };
  database.fail = true;
  await expect(
    view.run((storage) => new LocalProjectRunCommitter(storage).reviewQuality('r', receipt)),
  ).rejects.toThrow('Disk full');
  database.fail = false;
  expect(
    (await view.run((storage) => new LocalProjectTaskRunRepository(storage).get('r')))
      ?.qualityReviews,
  ).toBeUndefined();
  const results = await Promise.allSettled(
    [view, new RepositoryTransactions(database)].map((window) =>
      window.run((storage) => new LocalProjectRunCommitter(storage).reviewQuality('r', receipt)),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const reopen = new RepositoryTransactions(database);
  const saved = (await reopen.run((storage) =>
    new LocalProjectTaskRunRepository(storage).get('r'),
  ))!;
  expect(saved.qualityReviews?.[0]?.findings[0]?.repair).toBe('Add the required export header.');
  const rejection = await reopen.run((storage) =>
    new LocalProjectRunCommitter(storage).attemptVerify(
      'r',
      'Reviewed.',
      at,
      { expectedRun: saved },
      'rejection',
    ),
  );
  expect(rejection.error).toContain('every required criterion');
  expect(rejection.run.status).toBe('awaiting-review');
  const again = new RepositoryTransactions(database);
  const rejected = (await again.run((storage) =>
    new LocalProjectTaskRunRepository(storage).get('r'),
  ))!;
  expect(rejected.qualityRejections?.[0]?.reason).toContain('every required criterion');
  expect(rejected.qualityReviews).toEqual(saved.qualityReviews);
  await expect(
    again.run((storage) =>
      new LocalProjectTaskRunRepository(storage).save({ ...rejected, qualityReviews: [] }),
    ),
  ).rejects.toThrow('cannot be removed');
  database.fail = true;
  await expect(
    again.run((storage) =>
      new LocalProjectRunCommitter(storage).attemptVerify(
        'r',
        'Reviewed.',
        at,
        { expectedRun: rejected },
        'failed-write',
      ),
    ),
  ).rejects.toThrow('Disk full');
  database.fail = false;
  expect(
    (await again.run((storage) => new LocalProjectTaskRunRepository(storage).get('r')))
      ?.qualityRejections,
  ).toHaveLength(1);
});

it('retains old quality history beyond the former run limit and fails closed on corrupt quality records', async () => {
  const database = new TestDatabase();
  const view = new RepositoryTransactions(database);
  const at = '2026-09-11T10:00:00Z';
  const old: ProjectTaskRun = {
    version: 1,
    id: 'old',
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Controlled fixture',
    status: 'cancelled',
    cancelledAt: at,
    createdAt: at,
    updatedAt: at,
  };
  old.qualityRejections = [
    {
      id: 'retained-rejection',
      at,
      reason: 'Still requires review.',
      resultVersion: projectResultVersion(old),
    },
  ];
  await view.run(async (storage) => {
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(old);
    for (let i = 0; i < 251; i++)
      await repository.save({ ...old, id: `later-${i}`, qualityRejections: undefined });
  });
  expect(
    (await view.run((storage) => new LocalProjectTaskRunRepository(storage).get('old')))
      ?.qualityRejections?.[0]?.reason,
  ).toBe('Still requires review.');
  await view.run(async (storage) =>
    storage.setItem(
      'iris.projects.task-runs.v1',
      JSON.stringify([{ ...old, status: 'invalid-status' }]),
    ),
  );
  await expect(
    view.run((storage) => new LocalProjectTaskRunRepository(storage).list()),
  ).rejects.toThrow('quality history is invalid');
  expect(database.data.values['iris.projects.task-runs.v1']).toContain('retained-rejection');
});
