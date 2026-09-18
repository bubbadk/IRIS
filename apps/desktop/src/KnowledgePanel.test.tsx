// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgePanel } from './KnowledgePanel';
import { LocalKnowledgeRepository } from './knowledge';
import { SnapshotStorage } from './repositoryStorage';
import { resolveKnowledge } from '@iris/memory';
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
it('keeps an edit inactive until review, shows the conflicting value and preserves archived history', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new SnapshotStorage());
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent === label)!;
  const edit = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const repository = new LocalKnowledgeRepository();
  await act(async () => root.render(<KnowledgePanel scope={{ kind: 'global' }} />));
  await act(async () => button('Add knowledge').click());
  await edit(container.querySelector('form input')!, 'Writing language');
  await edit(container.querySelector('textarea')!, 'English');
  await act(async () => button('Save for review').click());
  expect(
    resolveKnowledge(await repository.list(), undefined, new Date().toISOString()).selected,
  ).toEqual([]);
  await act(async () => button('Approve for use').click());
  await act(async () => button('Create revision').click());
  await edit(container.querySelector('textarea')!, 'Danish');
  await act(async () => button('Save for review').click());
  expect(container.querySelector('.knowledge-conflict')?.textContent).toContain('English');
  expect(
    resolveKnowledge(await repository.list(), undefined, new Date().toISOString()).selected[0]
      .content,
  ).toBe('English');
  await act(async () => button('Approve and replace conflicting entries').click());
  expect(
    resolveKnowledge(await repository.list(), undefined, new Date().toISOString()).selected[0]
      .content,
  ).toBe('Danish');
  expect((await repository.list()).find((entry) => entry.content === 'English')?.status).toBe(
    'archived',
  );
  await act(async () => root.unmount());
});
