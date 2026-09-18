// Isolated real UI with a labelled controlled worker; no model or user profile is used.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.IRIS_PLAYWRIGHT_MODULE || 'playwright');
const dir = await mkdtemp(tmpdir() + '/iris-chat-web-');
const url = process.env.IRIS_SMOKE_URL || 'http://127.0.0.1:5192/?onboarding=false';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
const context = await chromium.launchPersistentContext(dir + '/profile', {
  executablePath: process.env.IRIS_CHROME || '/usr/bin/google-chrome-stable',
  headless: true,
  viewport: { width: 1500, height: 1000 },
  args: ['--no-sandbox'],
});
const page = await context.newPage();
try {
  await page.goto(url);
  await page.evaluate(async () => {
    const { agentRepository } = await import('/src/persistence.ts');
    await agentRepository.save({
      id: 'controlled-chat',
      name: 'Controlled UI test — no model',
      autonomy: 'assist',
      skillIds: [],
      toolIds: [],
    });
  });
  await page.reload();
  await page.evaluate(async () => {
    const source = await (await fetch('/src/useChatSession.ts')).text();
    const runtimeUrl = source.match(/from "([^"]*agentRuntime[^"]*)"/)[1];
    const { agentRuntime } = await import(runtimeUrl);
    const { conversationRepository } = await import('/src/persistence.ts');
    agentRuntime.send = async function* (id, input) {
      const messages = [{ role: 'user', content: input, turnId: 'fixture' }];
      await conversationRepository.save(id, messages);
      yield { type: 'user-message' };
      for (let i = 0; i < 12; i++) {
        const call = { id: `tool-${i}`, name: 'web_search', input: {} };
        yield { type: 'tool-call', call };
        yield {
          type: 'tool-failed',
          call,
          reason:
            'Controlled failure fixture: DuckDuckGo requires a human verification challenge. No search results were retrieved.',
        };
      }
      const content =
        '## Controlled layout test\n\nThis is a **controlled worker**, not model verification.\n\n| Item | Result |\n| --- | --- |\n| Web request | Blocked by human challenge |\n| File | Read |\n\n1. Inspect `file.txt`.\n2. Read [the source](https://example.com).\n\n```text\nA preserved code block\nwith another line\n```\n\n' +
        'Long reply paragraph with clearly separated content.\n\n'.repeat(12);
      messages.push({ role: 'assistant', content, turnId: 'fixture' });
      await conversationRepository.save(id, messages);
      yield { type: 'assistant-complete' };
    };
  });
  await page.getByPlaceholder('Start a chat or open an object…').click();
  await page
    .locator('.desktop-chat-composer textarea')
    .fill('Show the controlled formatting fixture.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.tool-failure-reason').first().waitFor();
  await page.locator('.rich-message h2').waitFor();
  assert.equal(await page.locator('.rich-message table tbody tr').count(), 2);
  assert.equal(await page.locator('.rich-message ol li').count(), 2);
  assert.equal(await page.locator('.tool-failure-reason').count(), 12);
  await page.locator('.desktop-chat-body').evaluate((e) => (e.scrollTop = 0));
  const layout = await page.evaluate(() => {
    const body = document.querySelector('.desktop-chat-body');
    const heading = document.querySelector('.desktop-chat-heading');
    const message = document.querySelector('.desktop-chat-message');
    const picker = document.querySelector('.desktop-agent-picker select').getBoundingClientRect();
    return {
      controlsVisible: !!document
        .elementFromPoint(picker.x + picker.width / 2, picker.y + picker.height / 2)
        ?.closest('.desktop-chat'),
      scrolls: body.scrollHeight > body.clientHeight,
      belowHeader: message.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom,
      rowDisplay: getComputedStyle(document.querySelector('.active-tool-item')).display,
    };
  });
  assert.deepEqual(layout, {
    controlsVisible: true,
    scrolls: true,
    belowHeader: true,
    rowDisplay: 'grid',
  });
  await page.screenshot({ path: dir + '/formatted-reply.png' });
  await page.locator('.tool-failure-reason').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: dir + '/visible-failure.png' });
  await page.reload();
  await page.getByPlaceholder('Start a chat or open an object…').click();
  await page.locator('.rich-message h2').waitFor();
  assert.equal(await page.locator('.rich-message table tbody tr').count(), 2);
  console.log(
    JSON.stringify({
      passed: true,
      directory: dir,
      controlledWorker: true,
      noModelCalls: true,
      layout,
      reloadRetainedReply: true,
    }),
  );
} catch (error) {
  await page.screenshot({ path: dir + '/failure.png' });
  console.error('Artifacts:', dir);
  throw error;
} finally {
  await context.close();
}
