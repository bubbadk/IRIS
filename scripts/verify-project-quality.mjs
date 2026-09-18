// Isolated real-app QC-2 smoke. Requires a running Vite server and Playwright.
// Only the labelled worker is controlled; review UI, runtime, checks and storage are real.
const { chromium } = await import(process.env.IRIS_PLAYWRIGHT_MODULE || 'playwright');
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const chrome = process.env.IRIS_CHROME || '/usr/bin/google-chrome-stable';
import assert from 'node:assert/strict';
const dir = await mkdtemp(join(tmpdir(), 'iris-qc2-browser-'));
console.log('Isolated artifact directory:', dir);
let context = await chromium.launchPersistentContext(dir + '/profile', {
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox'],
  viewport: { width: 1600, height: 1150 },
});
let page = await context.newPage();
const url = process.env.IRIS_SMOKE_URL || 'http://127.0.0.1:5192/?onboarding=false';
assert.ok(
  ['localhost', '127.0.0.1'].includes(new URL(url).hostname),
  'Use an isolated local app origin.',
);
async function installWorker() {
  await page.evaluate(async () => {
    const source = await (await fetch('/src/ProjectQualityReview.tsx')).text();
    const runtimeUrl = source.match(/from "([^"]*projectRuntime[^"]*)"/)[1];
    const runtimeModules = await Promise.all([
      import('/src/projectRuntime.ts'),
      import(runtimeUrl),
    ]);
    const { documentRepository: docs } = await import('/src/documents.ts');
    const workers = {
      prepare: async () => ({ agentName: 'CONTROLLED QC-2 SMOKE WORKER — NO MODEL' }),
      async *execute(input) {
        const turn = crypto.randomUUID();
        yield { type: 'started', runtimeTurnId: turn };
        if (input.previousRun) {
          const doc = await docs.get('qc2-document');
          await docs.revise(doc.id, doc.revisions.at(-1).id, {
            id: crypto.randomUUID(),
            content: 'Total EUR 10',
            createdAt: new Date().toISOString(),
            author: { kind: 'user', id: 'qc2-smoke', name: 'Controlled offline smoke fixture' },
          });
          if (!input.run.continuation.includes('Repair proposal'))
            throw new Error('Repair proposal was not used.');
        }
        yield {
          type: 'returned',
          runtimeTurnId: turn,
          output:
            'Controlled offline worker returned a document. No model or semantic evaluator was used.',
        };
      },
      async *resume() {
        throw new Error('No approval should be pending in this read-only fixture.');
      },
      cancel: async () => {},
      recover: async () => ({ status: 'failed', failure: 'No fixture checkpoint.' }),
    };
    for (const module of runtimeModules) module.projectWorkflowRuntime.workers = workers;
  });
}
async function openProjects() {
  const desktop = page
    .locator('.desktop-objects')
    .getByRole('button', { name: 'Projects', exact: true });
  await desktop.click();
  await page
    .getByRole('button', { name: 'Review worker result', exact: true })
    .or(page.getByRole('button', { name: 'Reopen', exact: true }))
    .first()
    .waitFor();
}
async function state() {
  return page.evaluate(async () => {
    const p = await import('/src/persistence.ts');
    return {
      runs: await p.projectTaskRunRepository.list('qc2-project'),
      project: await p.projectGraphRepository.get('qc2-project'),
    };
  });
}
async function reviewForm(outcome, resolve = false) {
  const quality = page.locator('.project-quality-review').last();
  await quality.getByLabel('Assessment 1', { exact: true }).selectOption(outcome);
  await quality
    .getByLabel('Rationale 1', { exact: true })
    .fill(
      outcome === 'met'
        ? 'Inspected the currency label: EUR.'
        : 'The saved total uses USD instead of EUR.',
    );
  await quality
    .getByLabel('Evidence 1', { exact: true })
    .fill('Opened QC2 export; inspected the Total line. Controlled smoke observations.');
  await quality.getByLabel('Assessment 2', { exact: true }).selectOption('met');
  await quality.getByLabel('Rationale 2', { exact: true }).fill('The total is 10.');
  await quality.getByLabel('Evidence 2', { exact: true }).fill('QC2 export, Total line: 10.');
  if (resolve)
    await quality
      .getByLabel('Resolution for Currency must be EUR', { exact: true })
      .fill('Opened the new revision and confirmed EUR 10.');
  return quality;
}
async function finalApprove() {
  const view = page.locator('.project-run-review').last();
  await view
    .getByLabel('What did you verify?')
    .fill(
      'Inspected the saved document and both explicit criteria. Controlled smoke review, no model validation.',
    );
  await view
    .getByLabel('I reviewed the acceptance criteria above against the saved deliverable.')
    .check();
  await view.getByRole('button', { name: 'Verify & complete task', exact: true }).click();
}
try {
  await page.goto(url);
  await page.evaluate(async (root) => {
    localStorage.clear();
    const w = await import(`/@fs${root}/packages/workflows/src/index.ts`);
    const p = await import('/src/persistence.ts');
    const { documentRepository: docs } = await import('/src/documents.ts');
    const at = new Date().toISOString();
    let project = w.createProjectGraph({
      id: 'qc2-project',
      title: 'QC-2 isolated acceptance journey',
      objective: 'CONTROLLED offline fixture. No model verification.',
      createdAt: at,
    });
    project = w.addProjectTask(project, {
      id: 'qc2-task',
      title: 'Review export currency and total',
      acceptanceCriteria: 'Currency is EUR\nTotal is 10',
      resultChecks: [
        {
          id: 'qc2-check',
          target: { kind: 'document', title: 'QC2 export' },
          assertion: 'nonempty',
        },
      ],
      turnLimit: 2,
      timeLimitMinutes: 10,
      createdAt: at,
    });
    project = w.addProjectTask(project, {
      id: 'qc2-dependent',
      title: 'Use the verified export',
      dependencyIds: ['qc2-task'],
      createdAt: at,
    });
    await p.projectGraphRepository.save(project);
    await docs.create({
      id: 'qc2-document',
      title: 'QC2 export',
      format: 'text',
      revision: {
        id: 'qc2-revision-1',
        content: 'Total USD 10',
        createdAt: at,
        author: { kind: 'user', id: 'qc2-smoke', name: 'Controlled offline smoke fixture' },
      },
    });
  }, repositoryRoot);
  await installWorker();
  await page.evaluate(async () => {
    const { projectWorkflowRuntime: r } = await import('/src/projectRuntime.ts');
    await r.launch({
      projectId: 'qc2-project',
      taskId: 'qc2-task',
      agentId: 'qc2-controlled-worker',
    });
  });
  await page.reload();
  await installWorker();
  await openProjects();
  console.log('Controlled worker returned; recording explicit criterion review.');
  await page.screenshot({ path: dir + '/project.png' });
  // Select the latest saved run in the actual history controls.
  const reviewButton = page.getByRole('button', { name: 'Review worker result', exact: true });
  if (await reviewButton.count()) await reviewButton.click();
  let quality = await reviewForm('unmet');
  // A competing editor changes instructions while this human review stays open.
  await page.evaluate(async () => {
    const { projectGraphRepository } = await import('/src/persistence.ts');
    const project = await projectGraphRepository.get('qc2-project');
    project.tasks[0].description = 'Inspect the Total line against the expected EUR 10.';
    await projectGraphRepository.save(project);
  });
  await quality.getByRole('button', { name: 'Save quality review', exact: true }).click();
  await quality
    .getByRole('alert')
    .filter({ hasText: 'task changed while this review was open' })
    .waitFor();
  assert.equal((await state()).runs[0].qualityReviews, undefined);
  assert.equal((await state()).project.tasks[0].completedAt, undefined);
  await page.screenshot({ path: dir + '/stale-task-review.png' });
  await page.reload();
  await installWorker();
  await openProjects();
  await page.getByRole('button', { name: 'Review worker result', exact: true }).click();
  quality = await reviewForm('unmet');
  await quality
    .getByText('Inspect the Total line against the expected EUR 10.', { exact: true })
    .waitFor();
  await quality.getByText('Add a quality finding or rejection reason', { exact: true }).click();
  await quality
    .getByLabel('Finding or rejection reason', { exact: true })
    .fill('Currency must be EUR');
  await quality
    .getByLabel('Concrete repair needed', { exact: true })
    .fill('Change only the currency label in the Total line from USD to EUR; retain total 10.');
  await quality.getByRole('button', { name: 'Save quality review', exact: true }).click();
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem('iris.projects.task-runs.v1')).some(
      (r) => r.qualityReviews?.length,
    ),
  );
  await finalApprove();
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem('iris.projects.task-runs.v1')).some(
      (r) => r.qualityRejections?.length,
    ),
  );
  assert.equal((await state()).project.tasks[0].completedAt, undefined);
  await page.reload();
  await installWorker();
  await openProjects();
  await page.getByRole('button', { name: 'Review worker result', exact: true }).click();
  await page
    .locator('.project-quality-review')
    .last()
    .getByText('Bounded repair proposal', { exact: true })
    .click();
  await page
    .locator('.project-quality-review')
    .last()
    .getByRole('button', { name: 'Continue with saved repair proposal' })
    .click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1')).length === 2 &&
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1'))[0].status ===
        'awaiting-review',
  );
  await page.getByRole('button', { name: 'Review worker result', exact: true }).click();
  quality = await reviewForm('met', true);
  await quality.getByRole('button', { name: 'Save quality review', exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1'))[0].qualityReviews?.length ===
      1,
  );
  // Alter a still-passing deliverable to exercise QC-1 with complete QC-2 coverage.
  await page.evaluate(async () => {
    const { documentRepository: d } = await import('/src/documents.ts');
    const doc = await d.get('qc2-document');
    await d.revise(doc.id, doc.revisions.at(-1).id, {
      id: crypto.randomUUID(),
      content: 'Total EUR 10\nStill passing, new revision.',
      createdAt: new Date().toISOString(),
      author: { kind: 'user', id: 'qc2-smoke', name: 'Controlled edit after review' },
    });
  });
  await finalApprove();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1'))[0].qualityRejections
        ?.length === 1,
  );
  assert.match((await state()).runs[0].qualityRejections[0].reason, /changed after/);
  assert.equal((await state()).project.tasks[0].completedAt, undefined);
  await page.screenshot({ path: dir + '/qc1-rejection.png' });
  quality = page.locator('.project-quality-review').last();
  await quality.getByText('Bounded repair proposal', { exact: true }).click();
  await quality.getByRole('button', { name: 'Continue with saved repair proposal' }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1')).length === 3 &&
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1'))[0].status ===
        'awaiting-review',
  );
  await page.getByRole('button', { name: 'Review worker result', exact: true }).click();
  quality = await reviewForm('met');
  await quality.getByRole('button', { name: 'Save quality review', exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('iris.projects.task-runs.v1'))[0].qualityReviews?.length ===
      1,
  );
  await finalApprove();
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('iris.projects.task-runs.v1'))[0].status === 'completed',
  );
  await page.screenshot({ path: dir + '/accepted.png' });
  const saved = await state();
  assert.ok(saved.project.tasks[0].completedAt);
  assert.ok(saved.runs[0].verification.checkReport);
  const records = await page.evaluate(() =>
    Object.fromEntries(
      ['iris.projects.graphs.v1', 'iris.projects.task-runs.v1', 'iris.documents.records.v1'].map(
        (key) => [key, localStorage.getItem(key)],
      ),
    ),
  );
  await writeFile(dir + '/records.json', JSON.stringify(records, null, 2));
  await context.close();
  context = await chromium.launchPersistentContext(dir + '/profile', {
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox'],
    viewport: { width: 1600, height: 1150 },
  });
  page = await context.newPage();
  await page.goto(url);
  await openProjects();
  assert.deepEqual(await state(), saved);
  await page.screenshot({ path: dir + '/restart.png' });
  console.log(
    JSON.stringify({
      passed: true,
      worker: 'Controlled offline fixture; no model calls',
      runs: saved.runs.length,
      rejectionCount: saved.runs.reduce((n, r) => n + (r.qualityRejections?.length ?? 0), 0),
      freshAcceptanceReceipt: true,
      browserRestartRetainedState: true,
      artifactDirectory: dir,
    }),
  );
} catch (error) {
  await page.screenshot({ path: dir + '/failure.png' });
  console.log('FAILURE UI', (await page.locator('body').innerText()).slice(-14000));
  throw error;
} finally {
  await context.close();
}
