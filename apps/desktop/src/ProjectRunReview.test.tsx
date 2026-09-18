// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTaskRun } from '@iris/workflows';
import { ProjectRunReview } from './ProjectRunReview';

const { verifyRun, continueRun, requestPause, resumeRun } = vi.hoisted(() => ({
  verifyRun: vi.fn(),
  continueRun: vi.fn(),
  requestPause: vi.fn(),
  resumeRun: vi.fn(),
}));
vi.mock('./persistence', () => ({
  projectTaskRunRepository: { list: vi.fn(async () => []) },
  projectGraphRepository: { get: async () => ({ tasks: [{ id: 'task', title: 'Export' }] }) },
}));
vi.mock('./projectRuntime', () => ({
  projectWorkflowRuntime: { verifyRun, continueRun, requestPause, resumeRun },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const run: ProjectTaskRun = {
  version: 1,
  id: 'run',
  projectId: 'project',
  taskId: 'task',
  agentId: 'agent',
  agentName: 'Worker',
  status: 'awaiting-review',
  createdAt: '2026-09-07T10:00:00Z',
  updatedAt: '2026-09-07T10:01:00Z',
  acceptanceCriteria: 'The export opens correctly.',
  output: 'Created the export.',
};

describe('project result review UI', () => {
  it('requires a review note and keeps a rejected verification visible', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    verifyRun.mockRejectedValue(new Error('A newer run exists.'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ProjectRunReview run={run} />));
    expect(container.textContent).toContain('IRIS has not independently verified it');
    expect(container.textContent).toContain(run.acceptanceCriteria);
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Verify & complete task',
    )!;
    expect(button.disabled).toBe(true);
    const textarea = container.querySelector(
      'textarea[placeholder="Record the checks and evidence you reviewed."]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Opened the exported file.',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button.disabled).toBe(true);
    const checkbox = container.querySelector<HTMLInputElement>(
      'form:has(textarea[placeholder="Record the checks and evidence you reviewed."]) input[type="checkbox"]',
    )!;
    await act(async () => checkbox.click());
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(verifyRun).toHaveBeenCalledWith('run', 'Opened the exported file.', run);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('A newer run exists.');
    expect(container.textContent).not.toContain('Verified by you');
    await act(async () => root.unmount());
  });

  it('offers continuation, but no completion button, when a runtime limit stopped the task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    continueRun.mockResolvedValue({ ...run, id: 'next' });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectRunReview run={{ ...run, status: 'needs-attention', stopReason: 'tool-limit' }} />,
      ),
    );
    expect(container.textContent).toContain('task remains unfinished');
    expect(container.textContent).not.toContain('Verify & complete');
    const form = [...container.querySelectorAll('form')].find((item) =>
      item.textContent?.includes('Continue from report'),
    )!;
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(continueRun).toHaveBeenCalledWith('run', '');
    expect(verifyRun).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
  it('keeps pause available while a resumed worker is running and reports resume failure', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let finish!: (value: ProjectTaskRun) => void;
    resumeRun.mockImplementation(
      () =>
        new Promise<ProjectTaskRun>((resolve) => {
          finish = resolve;
        }),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectRunReview run={{ ...run, status: 'paused', turnLimit: 4, turnsUsed: 1 }} />,
      ),
    );
    expect(container.textContent).toContain('Agent turns: 1 / 4');
    await act(async () => container.querySelector('button')!.click());
    expect(resumeRun).toHaveBeenCalledWith('run');
    await act(async () =>
      root.render(
        <ProjectRunReview run={{ ...run, status: 'running', turnLimit: 4, turnsUsed: 2 }} />,
      ),
    );
    expect(container.querySelector('button')!.disabled).toBe(false);
    await act(async () => container.querySelector('button')!.click());
    expect(requestPause).toHaveBeenCalledWith('run');
    await act(async () =>
      finish({ ...run, status: 'failed', failure: 'Checkpoint is unavailable.' }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Checkpoint is unavailable.',
    );
    await act(async () => root.unmount());
  });
});

it('shows persisted failed checks and evidence without offering completion', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ProjectRunReview
        run={{
          ...run,
          status: 'needs-attention',
          stopReason: 'check-failed',
          resultChecks: [
            {
              id: 'check',
              target: { kind: 'document', title: 'Brief' },
              assertion: 'contains',
              expected: 'Summary',
            },
          ],
          checkReports: [
            {
              runtimeTurnId: 'turn',
              checkedAt: run.updatedAt,
              results: [
                {
                  checkId: 'check',
                  status: 'failed',
                  message: 'Required text was not found.',
                  evidence: 'Document doc, revision 2.',
                },
              ],
            },
          ],
        }}
      />,
    ),
  );
  expect(container.textContent).toContain('0 / 1 passed');
  expect(container.textContent).toContain('Document doc, revision 2.');
  expect(container.textContent).toContain('Required text was not found.');
  expect(container.textContent).not.toContain('Verify & complete');
  await act(async () => root.unmount());
});
