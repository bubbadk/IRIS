// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { projectResultVersion, projectTaskVersion, type ProjectTaskRun } from '@iris/workflows';
import { ProjectQualityReview } from './ProjectQualityReview';
const { list, reviewQuality, continueRepair } = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  reviewQuality: vi.fn(),
  continueRepair: vi.fn(),
}));
vi.mock('./persistence', () => ({
  projectTaskRunRepository: { list },
  projectGraphRepository: { get: async () => ({ tasks: [task] }) },
}));
vi.mock('./projectRuntime', () => ({ projectWorkflowRuntime: { reviewQuality, continueRepair } }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
const at = '2026-09-11T10:00:00Z';
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
  output: 'Not proof.',
  acceptanceCriteria: 'Currency is EUR\nTotal is 10',
};
const task = {
  id: 't',
  title: 'Inspect the export',
  description: 'Compare the totals with the original source.',
  acceptanceCriteria: run.acceptanceCriteria,
  dependencyIds: [],
  createdAt: at,
};

it('defaults criteria to unverified and sends explicit human observations without starting a worker', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ProjectQualityReview run={run} canAct />));
  expect(container.textContent).toContain('0 / 2 criteria met');
  const select = container.querySelector('select')!;
  expect(select.value).toBe('unverified');
  await act(async () => {
    select.value = 'unmet';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const textareas = container.querySelectorAll('textarea');
  for (const [index, value] of ['Wrong currency.', 'Inspected export revision 1.'].entries()) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textareas[index],
        value,
      );
      textareas[index]!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(reviewQuality).toHaveBeenCalledWith(
    'r',
    {
      assessments: [
        {
          criterion: 0,
          outcome: 'unmet',
          rationale: 'Wrong currency.',
          evidence: 'Inspected export revision 1.',
        },
      ],
      findings: [],
      resolutions: [],
    },
    run,
    projectTaskVersion(task),
  );
  expect(continueRepair).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('renders saved evidence and blocking history on remount without enabling read-only actions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const saved: ProjectTaskRun = {
    ...run,
    qualityReviews: [
      {
        id: 'review',
        method: 'human-review',
        reviewedAt: at,
        projectId: 'p',
        taskId: 't',
        runId: 'r',
        criteriaVersion: run.acceptanceCriteria!,
        taskVersion: projectTaskVersion(task),
        resultVersion: projectResultVersion(run),
        assessments: [
          {
            criterion: 0,
            outcome: 'unmet',
            rationale: 'Wrong currency.',
            evidence: 'Export revision 1 uses USD.',
          },
        ],
        findings: [
          {
            id: 'finding',
            blocking: true,
            reason: 'Currency is wrong.',
            repair: 'Change USD to EUR.',
          },
        ],
        resolutions: [],
      },
    ],
    qualityRejections: [
      {
        id: 'rejection',
        at,
        reason: 'Missing required criterion coverage.',
        resultVersion: projectResultVersion(run),
      },
    ],
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<ProjectQualityReview run={saved} canAct={false} />));
  expect(container.textContent).toContain('Blocking: Currency is wrong.');
  expect(container.textContent).toContain('Export revision 1 uses USD.');
  expect(container.textContent).toContain('Missing required criterion coverage.');
  expect(container.querySelector('button')).toBeNull();
  expect(container.querySelector('fieldset')!.disabled).toBe(true);
  await act(async () => root.unmount());
});
