import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '@iris/workspaces';
import { exportDocument } from './documentExport';

/**
 * Phase 2E / M-17: the renderer must never be able to name a host path.
 *
 * The export command owns the destination: it opens the native Save dialog in the backend, issues a
 * one-time capability token for the path the user chose, and this module forwards only that token.
 * These tests pin the exact IPC surface so a future change cannot quietly reintroduce an
 * arbitrary-write parameter.
 */
const invoke = vi.fn();
const save = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => save(...args),
  open: vi.fn(),
}));

const doc = createDocument({
  id: 'destination',
  title: 'Destination report',
  format: 'markdown',
  revision: {
    id: 'revision-1',
    content: '# Destination\nBody text.',
    createdAt: '2026-09-08T10:00:00Z',
    author: { kind: 'user', id: 'user', name: 'You' },
  },
});

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
});

describe('M-17 trusted export destination', () => {
  it('asks the backend for a destination and then redeems only the returned token', async () => {
    invoke
      .mockResolvedValueOnce({ token: 'opaque-token', path: '/home/user/report.pdf' })
      .mockResolvedValueOnce('/home/user/report.pdf');
    const result = await exportDocument(doc, doc.revisions[0].content, 'pdf');
    expect(result).toBe('/home/user/report.pdf');
    expect(invoke).toHaveBeenCalledTimes(2);
    const [beginCommand, beginArgs] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(beginCommand).toBe('begin_document_export');
    expect(Object.keys(beginArgs).sort()).toEqual(['extension', 'suggestedName']);
    expect(beginArgs.extension).toBe('pdf');
    expect(String(beginArgs.suggestedName).endsWith('.pdf')).toBe(true);
    const [saveCommand, saveArgs] = invoke.mock.calls[1] as [string, Record<string, unknown>];
    expect(saveCommand).toBe('save_document_export');
    // No call anywhere carries a host path.
    expect(Object.keys(saveArgs).sort()).toEqual(['data', 'ticket']);
    expect(saveArgs.ticket).toBe('opaque-token');
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('/home/user');
  });

  it('never opens a save dialog from the renderer', async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await exportDocument(doc, doc.revisions[0].content, 'pdf')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('reports the real destination only after the backend confirms the write', async () => {
    invoke
      .mockResolvedValueOnce({ token: 'opaque-token', path: '/home/user/report.pdf' })
      .mockRejectedValueOnce(new Error('Document export could not be saved: permission denied'));
    await expect(exportDocument(doc, doc.revisions[0].content, 'pdf')).rejects.toThrow(
      'permission denied',
    );
  });

  it('sends the complete base64 payload for the chosen format', async () => {
    invoke
      .mockResolvedValueOnce({ token: 'opaque-token', path: '/home/user/report.pdf' })
      .mockResolvedValueOnce('/home/user/report.pdf');
    await exportDocument(doc, doc.revisions[0].content, 'pdf');
    const data = (invoke.mock.calls[1] as [string, { data: string }])[1].data;
    const decoded = Buffer.from(data, 'base64').toString('latin1');
    expect(decoded.startsWith('%PDF-1.4')).toBe(true);
    expect(decoded.endsWith('%%EOF\n')).toBe(true);
    expect(decoded).toContain('Body text.');
  });
});
