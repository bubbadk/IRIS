// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DocumentsState } from './DocumentsState';
import { LocalDocumentRepository } from './documents';
import { exportDocument } from './documentExport';
vi.mock('./documentExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./documentExport')>()),
  exportDocument: vi.fn(),
}));
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
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
it('keeps drafts while navigating and preserves an editable revision across a remount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
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
  await act(async () => root.render(<DocumentsState />));
  await act(async () => button('New document').click());
  await edit(container.querySelector('input')!, 'Saved report');
  await edit(container.querySelector('textarea')!, '# First revision');
  expect(button('New document').disabled).toBe(true);
  await act(async () => button('Create document').click());
  expect((await new LocalDocumentRepository().list())[0].revisions).toHaveLength(1);
  await edit(container.querySelector('textarea')!, '# Second revision');
  expect(container.querySelector<HTMLButtonElement>('aside button')!.disabled).toBe(true);
  expect(button('Export Word').disabled).toBe(true);
  await act(async () => button('Save revision').click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<DocumentsState />));
  await act(async () => container.querySelector<HTMLButtonElement>('aside button')!.click());
  expect(container.querySelector('textarea')!.value).toBe('# Second revision');
  const saved = (await new LocalDocumentRepository().list())[0];
  const history = container.querySelector('select')!;
  await act(async () => {
    history.value = saved.revisions[0].id;
    history.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('textarea')!.value).toBe('# First revision');
  expect(container.querySelector('textarea')!.readOnly).toBe(true);
  await act(async () => button('Use as new draft').click());
  await act(async () => button('Save revision').click());
  expect(
    (await new LocalDocumentRepository().list())[0].revisions.map((revision) => revision.content),
  ).toEqual(['# First revision', '# Second revision', '# First revision']);
  await act(async () => root.unmount());
});

async function renderDocuments() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DocumentsState />));
  return { container, root };
}

function buttonIn(container: HTMLElement, label: string) {
  return [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
}

async function editTextarea(container: HTMLElement, value: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectFirstDocument(container: HTMLElement) {
  await act(async () => container.querySelector<HTMLButtonElement>('aside button')!.click());
}

async function seed(format: 'markdown' | 'html' | 'csv', title = 'Seeded document') {
  return new LocalDocumentRepository().create({
    id: crypto.randomUUID(),
    title,
    format,
    revision: {
      id: crypto.randomUUID(),
      content: 'first revision',
      createdAt: new Date().toISOString(),
      author: { kind: 'user', id: 'local-user', name: 'You' },
    },
  });
}

it('never reports a successful export when the exporter fails', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await seed('markdown');
  const { container, root } = await renderDocuments();
  await selectFirstDocument(container);
  vi.mocked(exportDocument).mockRejectedValueOnce(new Error('The PDF export is incomplete.'));
  await act(async () => buttonIn(container, 'Export PDF')!.click());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    'The PDF export is incomplete.',
  );
  expect(container.textContent).not.toContain('Exported:');
  await act(async () => root.unmount());
});

it('never reports a saved revision when durable storage rejects the write', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const document = await seed('markdown');
  const durable = localStorage.getItem('iris.documents.records.v1');
  localStorage.setItem = () => {
    throw new DOMException('Exceeded the storage quota.', 'QuotaExceededError');
  };
  const { container, root } = await renderDocuments();
  await selectFirstDocument(container);
  await editTextarea(container, 'second revision');
  await act(async () => buttonIn(container, 'Save revision')!.click());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('nothing was saved');
  expect(container.textContent).not.toContain('Revision saved.');
  expect(localStorage.getItem('iris.documents.records.v1')).toBe(durable);
  expect(
    (await new LocalDocumentRepository().get(document.id))!.revisions.map(
      (revision) => revision.content,
    ),
  ).toEqual(['first revision']);
  await act(async () => root.unmount());
});

it('offers only the conversions the capability matrix supports', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await seed('html', 'Markup document');
  const markup = await renderDocuments();
  await selectFirstDocument(markup.container);
  for (const label of ['Export Word', 'Export PDF', 'Export XLSX', 'Export slides', 'Export CSV'])
    expect(buttonIn(markup.container, label)).toBeUndefined();
  expect(buttonIn(markup.container, 'Export original format')).toBeDefined();
  await act(async () => markup.root.unmount());

  document.body.innerHTML = '';
  await seed('csv', 'Rows');
  const rows = await renderDocuments();
  await selectFirstDocument(rows.container);
  for (const label of ['Export PDF', 'Export XLSX', 'Export CSV'])
    expect(buttonIn(rows.container, label)).toBeDefined();
  for (const label of ['Export Word', 'Export slides'])
    expect(buttonIn(rows.container, label)).toBeUndefined();
  await act(async () => rows.root.unmount());
});
