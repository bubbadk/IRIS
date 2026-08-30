import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceMount, WorkspaceRepository, WorkspaceService } from '@iris/workspaces';
import { createAgentWorkspaceContext, NativeWorkspaceService } from './workspace';

function repository(initial: WorkspaceMount | null = null): WorkspaceRepository {
  let stored = initial;
  return {
    get: async () => (stored ? { ...stored } : null),
    save: async (mount) => {
      stored = { ...mount };
    },
    clear: async () => {
      stored = null;
    },
  };
}

describe('native workspace service', () => {
  it('canonicalizes and persists a user-selected native workspace', async () => {
    const invokeNative = vi.fn(async (command: string) => {
      expect(command).toBe('mount_workspace');
      return { name: 'IRIS', rootPath: '/home/user/IRIS' };
    });
    const service = new NativeWorkspaceService(repository(), {
      available: () => true,
      invokeNative,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      createId: () => 'workspace-1',
    });

    await expect(service.mount('/home/user/IRIS/')).resolves.toEqual({
      version: 1,
      id: 'workspace-1',
      name: 'IRIS',
      rootPath: '/home/user/IRIS',
      connectedAt: '2026-08-27T12:00:00.000Z',
      verifiedAt: '2026-08-27T12:00:00.000Z',
    });
    expect(invokeNative).toHaveBeenCalledWith('mount_workspace', {
      rootPath: '/home/user/IRIS/',
    });
  });

  it('restores the configured root before listing real entries', async () => {
    const mount: WorkspaceMount = {
      version: 1,
      id: 'workspace-1',
      name: 'IRIS',
      rootPath: '/home/user/IRIS',
      connectedAt: '2026-08-27T12:00:00.000Z',
      verifiedAt: '2026-08-27T12:00:00.000Z',
    };
    const invokeNative = vi.fn(async (command: string) => {
      if (command === 'mount_workspace') return { name: 'IRIS', rootPath: mount.rootPath };
      if (command === 'list_workspace') {
        return {
          relativePath: '',
          entries: [
            {
              name: 'src',
              relativePath: 'src',
              kind: 'directory',
              size: null,
              modifiedAtMs: 1_787_829_600_000,
            },
          ],
          truncated: false,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = new NativeWorkspaceService(repository(mount), {
      available: () => true,
      invokeNative,
      now: () => new Date('2026-08-27T12:05:00.000Z'),
      createId: () => 'unused',
    });

    await expect(service.list()).resolves.toMatchObject({
      relativePath: '',
      entries: [{ name: 'src', relativePath: 'src', kind: 'directory' }],
    });
    expect(invokeNative.mock.calls.map(([command]) => command)).toEqual([
      'mount_workspace',
      'list_workspace',
    ]);
  });

  it('keeps browser preview honest and never invokes native file access', async () => {
    const invokeNative = vi.fn();
    const service = new NativeWorkspaceService(repository(), {
      available: () => false,
      invokeNative,
      now: () => new Date(),
      createId: () => 'unused',
    });

    await expect(service.current()).resolves.toBeNull();
    await expect(service.list()).rejects.toThrow('native IRIS desktop app');
    expect(invokeNative).not.toHaveBeenCalled();
  });

  it('routes directory and bounded file writes through native commands', async () => {
    const mount: WorkspaceMount = {
      version: 1,
      id: 'workspace-1',
      name: 'IRIS',
      rootPath: '/home/user/IRIS',
      connectedAt: '2026-08-27T12:00:00.000Z',
      verifiedAt: '2026-08-27T12:00:00.000Z',
    };
    const invokeNative = vi.fn(async (command: string) => {
      if (command === 'mount_workspace') return { name: 'IRIS', rootPath: mount.rootPath };
      if (command === 'create_workspace_directory') {
        return { relativePath: 'notes', kind: 'directory', created: true, bytesWritten: null };
      }
      if (command === 'write_workspace_file') {
        return { relativePath: 'notes/hej.txt', kind: 'file', created: true, bytesWritten: 3 };
      }
      if (command === 'move_workspace_entry') {
        return { sourcePath: 'notes/hej.txt', targetPath: 'archive/hej.txt', kind: 'file' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = new NativeWorkspaceService(repository(mount), {
      available: () => true,
      invokeNative,
      now: () => new Date('2026-08-27T12:05:00.000Z'),
      createId: () => 'unused',
    });

    await expect(service.createDirectory('notes')).resolves.toMatchObject({
      relativePath: 'notes',
      kind: 'directory',
      created: true,
    });
    await expect(service.writeFile('notes/hej.txt', 'Hej', false)).resolves.toEqual({
      relativePath: 'notes/hej.txt',
      kind: 'file',
      created: true,
      bytesWritten: 3,
    });
    await expect(service.move('notes/hej.txt', 'archive/hej.txt')).resolves.toEqual({
      sourcePath: 'notes/hej.txt',
      targetPath: 'archive/hej.txt',
      kind: 'file',
    });
    expect(invokeNative).toHaveBeenCalledWith('create_workspace_directory', {
      relativePath: 'notes',
    });
    expect(invokeNative).toHaveBeenCalledWith('write_workspace_file', {
      relativePath: 'notes/hej.txt',
      content: 'Hej',
      overwrite: false,
    });
    expect(invokeNative).toHaveBeenCalledWith('move_workspace_entry', {
      sourcePath: 'notes/hej.txt',
      targetPath: 'archive/hej.txt',
    });
  });
});

describe('agent workspace context', () => {
  const mount: WorkspaceMount = {
    version: 1,
    id: 'workspace-1',
    name: 'IRIS',
    rootPath: '/home/user/IRIS',
    connectedAt: '2026-08-27T12:00:00.000Z',
    verifiedAt: '2026-08-27T12:00:00.000Z',
  };

  it('distinguishes a mounted workspace from assigned file access', async () => {
    const mountedService = serviceWithCurrent(mount);
    const context = createAgentWorkspaceContext(repository(mount), mountedService);
    await expect(
      context.build({
        id: 'agent-1',
        name: 'Observer',
        autonomy: 'assist',
        skillIds: [],
        toolIds: [],
      }),
    ).resolves.toEqual([expect.stringContaining('no workspace tools assigned')]);
    await expect(
      context.build({
        id: 'agent-2',
        name: 'Reader',
        autonomy: 'assist',
        skillIds: [],
        toolIds: ['workspace.read'],
      }),
    ).resolves.toEqual([
      expect.stringMatching(/workspace “IRIS” is mounted at “\/home\/user\/IRIS”.*workspace\.read/),
    ]);
  });
});

function serviceWithCurrent(mount: WorkspaceMount): WorkspaceService {
  return {
    current: async () => mount,
    mount: vi.fn(),
    unmount: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    search: vi.fn(),
    createDirectory: vi.fn(),
    writeFile: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    applyPatch: vi.fn(),
  };
}
