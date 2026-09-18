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
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

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
