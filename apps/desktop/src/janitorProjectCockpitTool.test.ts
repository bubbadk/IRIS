import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { createJanitorProjectCockpitTool } from './janitorProjectCockpitTool';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const tool = createJanitorProjectCockpitTool();

beforeEach(() => {
  globalThis.localStorage = storage();
  invoke.mockReset();
});

describe('ProjectCockpit mutation preflight', () => {
  it('requires preview before a mutation request', async () => {
    await expect(tool.run({ method: 'PATCH', path: '/api/sites/iris', body: { image: 'new' } }, {} as never))
      .rejects.toThrow(/preview/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('snapshots the live resource and applies only an unchanged approved plan', async () => {
    invoke
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 200, body: '{"ok":true}' })
      .mockResolvedValueOnce({ status: 200, body: '{"image":"new"}' });

    const preview = (await tool.run(
      { operation: 'preview', method: 'PATCH', path: '/api/sites/iris', body: { image: 'new' } },
      {} as never,
    )) as { snapshotId: string; changed: boolean; diff: Array<{ kind: string; text: string }> };
    expect(preview.changed).toBe(true);
    expect(preview.diff).toEqual([
      { kind: 'removed', text: '{"image":"old"}' },
      { kind: 'added', text: '{"image":"new"}' },
    ]);

    const result = await tool.run(
      {
        operation: 'apply',
        method: 'PATCH',
        path: '/api/sites/iris',
        body: { image: 'new' },
        snapshotId: preview.snapshotId,
      },
      {} as never,
    );
    expect(result).toMatchObject({ status: 'applied', verified: true });
    expect(invoke).toHaveBeenNthCalledWith(3, 'janitor_projectcockpit_request', {
      method: 'PATCH',
      path: '/api/sites/iris',
      body: { image: 'new' },
    });
  });

  it('refuses a stale resource without sending the mutation', async () => {
    invoke
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 200, body: '{"image":"someone-else"}' });
    const preview = (await tool.run(
      { operation: 'preview', method: 'PUT', path: '/api/sites/iris', body: { image: 'new' } },
      {} as never,
    )) as { snapshotId: string };
    await expect(
      tool.run(
        { operation: 'apply', method: 'PUT', path: '/api/sites/iris', body: { image: 'new' }, snapshotId: preview.snapshotId },
        {} as never,
      ),
    ).rejects.toThrow(/changed after preview/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('consumes an approved preflight before applying so it cannot be replayed', async () => {
    invoke
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 200, body: '{"ok":true}' })
      .mockResolvedValueOnce({ status: 200, body: '{"image":"new"}' });

    const preview = (await tool.run(
      { operation: 'preview', method: 'PATCH', path: '/api/sites/iris', body: { image: 'new' } },
      {} as never,
    )) as { snapshotId: string };

    await tool.run(
      {
        operation: 'apply',
        method: 'PATCH',
        path: '/api/sites/iris',
        body: { image: 'new' },
        snapshotId: preview.snapshotId,
      },
      {} as never,
    );

    await expect(
      tool.run(
        {
          operation: 'apply',
          method: 'PATCH',
          path: '/api/sites/iris',
          body: { image: 'new' },
          snapshotId: preview.snapshotId,
        },
        {} as never,
      ),
    ).rejects.toThrow(/Unknown or expired/);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('reports an unsuccessful live verification without inventing success', async () => {
    invoke
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 200, body: '{"image":"old"}' })
      .mockResolvedValueOnce({ status: 202, body: '{"accepted":true}' })
      .mockResolvedValueOnce({ status: 503, body: '{"error":"not ready"}' });

    const preview = (await tool.run(
      { operation: 'preview', method: 'POST', path: '/api/deployments', body: { image: 'new' } },
      {} as never,
    )) as { snapshotId: string };
    const result = (await tool.run(
      {
        operation: 'apply',
        method: 'POST',
        path: '/api/deployments',
        body: { image: 'new' },
        snapshotId: preview.snapshotId,
      },
      {} as never,
    )) as { verified: boolean; verification: { status: number } };

    expect(result.verified).toBe(false);
    expect(result.verification.status).toBe(503);
  });
});
