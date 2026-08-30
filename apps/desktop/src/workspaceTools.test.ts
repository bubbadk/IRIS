import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceService } from '@iris/workspaces';
import {
  createWorkspaceDirectoryTool,
  createWorkspaceListTool,
  createWorkspaceReadTool,
  createWorkspaceSearchTool,
  createWorkspaceWriteTool,
  createWorkspaceMoveTool,
  createWorkspaceDeleteTool,
  createWorkspacePatchTool,
} from './workspaceTools';

function service(): WorkspaceService {
  return {
    current: vi.fn(),
    mount: vi.fn(),
    unmount: vi.fn(),
    list: vi.fn(async (relativePath = '') => ({ relativePath, entries: [], truncated: false })),
    read: vi.fn(async (relativePath, maxBytes) => ({
      relativePath,
      content: 'IRIS',
      bytesRead: maxBytes ?? 4,
      truncated: false,
    })),
    search: vi.fn(async (query) => ({
      query,
      matches: [],
      scannedEntries: 1,
      truncated: false,
    })),
    createDirectory: vi.fn(async (relativePath) => ({
      relativePath,
      kind: 'directory' as const,
      created: true,
    })),
    writeFile: vi.fn(async (relativePath, content) => ({
      relativePath,
      kind: 'file' as const,
      created: true,
      bytesWritten: new TextEncoder().encode(content).byteLength,
    })),
    move: vi.fn(async (sourcePath, targetPath) => ({
      sourcePath,
      targetPath,
      kind: 'file' as const,
    })),
    delete: vi.fn(async (relativePath) => ({
      relativePath,
      kind: 'file' as const,
    })),
    applyPatch: vi.fn(async (relativePath, _expectedContent, updatedContent) => ({
      relativePath,
      kind: 'file' as const,
      created: false,
      bytesWritten: new TextEncoder().encode(updatedContent).byteLength,
      changed: true,
    })),
  };
}

const context = { agentId: 'agent-1', agentName: 'Operator' };

describe('workspace tools', () => {
  it('lists only workspace-relative directories', async () => {
    const workspace = service();
    const tool = createWorkspaceListTool(workspace);
    await expect(tool.run({ path: 'src' }, context)).resolves.toMatchObject({
      relativePath: 'src',
    });
    expect(workspace.list).toHaveBeenCalledWith('src');
    await expect(tool.run({ path: '../outside' }, context)).rejects.toThrow('inside');
  });

  it('reads a bounded UTF-8 file through the service boundary', async () => {
    const workspace = service();
    const tool = createWorkspaceReadTool(workspace);
    await expect(tool.run({ path: './README.md', maxBytes: 1024 }, context)).resolves.toMatchObject(
      {
        relativePath: 'README.md',
        content: 'IRIS',
      },
    );
    expect(workspace.read).toHaveBeenCalledWith('README.md', 1024);
    await expect(tool.run({ path: 'README.md', maxBytes: 2_000_000 }, context)).rejects.toThrow(
      'maxBytes',
    );
  });

  it('requires a real bounded search query', async () => {
    const workspace = service();
    const tool = createWorkspaceSearchTool(workspace);
    await expect(
      tool.run({ query: ' permission ', maxResults: 10 }, context),
    ).resolves.toMatchObject({
      query: 'permission',
    });
    expect(workspace.search).toHaveBeenCalledWith('permission', 10);
    await expect(tool.run({ query: '' }, context)).rejects.toThrow('requires a query');
  });

  it('creates one validated workspace-relative directory and reports the mutation', async () => {
    const workspace = service();
    const changed = vi.fn();
    const tool = createWorkspaceDirectoryTool(workspace, changed);
    await expect(tool.run({ path: './notes' }, context)).resolves.toEqual({
      relativePath: 'notes',
      kind: 'directory',
      created: true,
    });
    expect(workspace.createDirectory).toHaveBeenCalledWith('notes');
    expect(changed).toHaveBeenCalledOnce();
    await expect(tool.run({ path: '../../outside' }, context)).rejects.toThrow('inside');
  });

  it('writes bounded UTF-8 content with explicit overwrite intent', async () => {
    const workspace = service();
    const changed = vi.fn();
    const tool = createWorkspaceWriteTool(workspace, changed);
    await expect(
      tool.run({ path: 'notes/hej.txt', content: 'Hej', overwrite: true }, context),
    ).resolves.toMatchObject({
      relativePath: 'notes/hej.txt',
      kind: 'file',
      bytesWritten: 3,
    });
    expect(workspace.writeFile).toHaveBeenCalledWith('notes/hej.txt', 'Hej', true);
    expect(changed).toHaveBeenCalledOnce();
    await expect(
      tool.run({ path: 'notes/hej.txt', content: 'Hej', overwrite: 'yes' }, context),
    ).rejects.toThrow('true or false');
  });

  it('moves only validated relative entries and refreshes after success', async () => {
    const workspace = service();
    const changed = vi.fn();
    const tool = createWorkspaceMoveTool(workspace, changed);
    await expect(
      tool.run({ sourcePath: './notes/hej.txt', targetPath: 'archive/hej.txt' }, context),
    ).resolves.toEqual({
      sourcePath: 'notes/hej.txt',
      targetPath: 'archive/hej.txt',
      kind: 'file',
    });
    expect(workspace.move).toHaveBeenCalledWith('notes/hej.txt', 'archive/hej.txt');
    expect(changed).toHaveBeenCalledOnce();
    await expect(
      tool.run({ sourcePath: 'notes/hej.txt', targetPath: 'notes/hej.txt' }, context),
    ).rejects.toThrow('different');
    await expect(
      tool.run({ sourcePath: '../outside', targetPath: 'archive/file' }, context),
    ).rejects.toThrow('inside');
  });

  it('deletes only validated relative entries and refreshes after success', async () => {
    const workspace = service();
    const changed = vi.fn();
    const tool = createWorkspaceDeleteTool(workspace, changed);
    await expect(tool.run({ path: './notes/hej.txt' }, context)).resolves.toEqual({
      relativePath: 'notes/hej.txt',
      kind: 'file',
    });
    expect(workspace.delete).toHaveBeenCalledWith('notes/hej.txt');
    expect(changed).toHaveBeenCalledOnce();
    await expect(tool.run({ path: '../outside' }, context)).rejects.toThrow('inside');
  });

  it('applies a bounded optimistic patch and refreshes after success', async () => {
    const workspace = service();
    const changed = vi.fn();
    const tool = createWorkspacePatchTool(workspace, changed);
    await expect(
      tool.run({ path: './notes/hej.txt', expectedContent: 'old', updatedContent: 'new' }, context),
    ).resolves.toMatchObject({
      relativePath: 'notes/hej.txt',
      changed: true,
    });
    expect(workspace.applyPatch).toHaveBeenCalledWith('notes/hej.txt', 'old', 'new');
    expect(changed).toHaveBeenCalledOnce();
    await expect(
      tool.run({ path: '../outside', expectedContent: 'old', updatedContent: 'new' }, context),
    ).rejects.toThrow('inside');
  });
});
