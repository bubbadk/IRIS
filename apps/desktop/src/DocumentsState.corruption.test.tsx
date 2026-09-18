// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentsState } from './DocumentsState';

/**
 * Phase 2I.4 regression suite — a corrupt document store must read as one truthful state.
 *
 * The defect this pins: `documentRepository.list()` threw "Saved documents are invalid. Existing
 * data has been retained.", the component set `loaded = true` with an empty list, and then rendered
 * **both** that error alert and the empty-state invitation ("No documents saved yet." / "A home for
 * your deliverables."). The UI simultaneously denied and asserted the user's data.
 *
 * No data loss was involved — every write path re-reads and throws — so this is a truthfulness fix:
 * the empty state may only appear when the store was actually read successfully and is empty.
 */

const storageKey = 'iris.documents.records.v1';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  } satisfies Storage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button labelled "${label}".`);
  return found as HTMLButtonElement;
}

async function edit(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DocumentsState />));
  return container;
}

describe('Documents UI under a corrupt store', () => {
  it('reports the error without claiming there are no documents', async () => {
    localStorage.setItem(storageKey, '{ not valid json');
    const container = await render();
    const text = container.textContent ?? '';
    // The failure is stated.
    expect(text).toContain('invalid');
    // The contradictions must not appear.
    expect(text).not.toContain('No documents saved yet.');
    expect(text).not.toContain('A home for your deliverables.');
    expect(text).not.toContain('Create a document, or assign the document tools');
    // The retention promise is stated instead, and the corrupt value is untouched.
    expect(text).toContain('Existing data has been retained');
    expect(localStorage.getItem(storageKey)).toBe('{ not valid json');
  });

  it('reports the error for a structurally valid but invalid document list', async () => {
    localStorage.setItem(storageKey, JSON.stringify([{ id: 'not-a-document' }]));
    const container = await render();
    const text = container.textContent ?? '';
    expect(text).toContain('invalid');
    expect(text).not.toContain('No documents saved yet.');
    expect(text).not.toContain('A home for your deliverables.');
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify([{ id: 'not-a-document' }]));
  });

  it('still shows the genuine empty state for an empty store', async () => {
    const container = await render();
    const text = container.textContent ?? '';
    expect(text).toContain('No documents saved yet.');
    expect(text).toContain('A home for your deliverables.');
    expect(text).not.toContain('Existing data has been retained');
  });
});

describe('Documents UI after a successful reload', () => {
  /**
   * Regression for F2. The success branch replaced the document list and cleared `loadFailed`, but
   * never cleared the error string, and the alert renders whenever that string is non-empty. After
   * a corrupt store was repaired and "Refresh documents" was pressed, the UI showed the real
   * document list and the "Existing data has been retained" error at the same time — it denied data
   * it was displaying. Only the first load was pinned, which is why this shipped.
   */
  it('stops denying the data once a reload succeeds', async () => {
    const documents = await import('./documents');
    const { createDocument } = await import('@iris/workspaces');
    const document = createDocument({
      id: 'recovered',
      title: 'Recovered plan',
      format: 'markdown',
      revision: {
        id: 'revision-1',
        content: '# Recovered',
        createdAt: '2026-09-18T10:00:00Z',
        author: { kind: 'user', id: 'user', name: 'You' },
      },
    });
    vi.spyOn(documents.documentRepository, 'list')
      .mockRejectedValueOnce(
        new Error('Saved documents are invalid. Existing data has been retained.'),
      )
      .mockResolvedValue([document]);

    const container = await render();
    expect(container.textContent).toContain('Existing data has been retained');

    await act(async () => findButton(container, 'Refresh documents').click());

    const text = container.textContent ?? '';
    expect(text).not.toContain('Existing data has been retained');
    expect(text).not.toContain('Saved documents could not be read.');
    expect(text).toContain('Recovered plan');
  });

  /**
   * The converse must also hold: a successful reload is evidence about the *load* only. It may
   * clear the load error it supersedes, but it must not erase a refused save or export that the
   * user has not read yet.
   */
  it('keeps an action error that the reload did not supersede', async () => {
    const documents = await import('./documents');
    vi.spyOn(documents.documentRepository, 'list').mockResolvedValue([]);
    vi.spyOn(documents.documentRepository, 'create').mockRejectedValue(
      new Error('The document could not be created.'),
    );

    const container = await render();
    await act(async () => findButton(container, 'New document').click());
    await edit(container.querySelector('input')!, 'Refused document');
    await act(async () => findButton(container, 'Create document').click());
    expect(container.textContent).toContain('The document could not be created.');

    await act(async () => findButton(container, 'Refresh documents').click());

    expect(container.textContent).toContain('The document could not be created.');
  });
});
