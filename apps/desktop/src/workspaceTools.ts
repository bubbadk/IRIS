import type { RegisteredTool } from '@iris/tools';
import {
  requireWorkspaceFileContent,
  requireWorkspaceQuery,
  requireWorkspaceRelativePath,
  type WorkspaceService,
} from '@iris/workspaces';
import { notifyWorkspaceChanged, workspaceService } from './workspace';

function inputObject(input: unknown, toolName: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${toolName} requires an object input.`);
  }
  return input as Record<string, unknown>;
}

function optionalBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

export function createWorkspaceListTool(
  service: WorkspaceService = workspaceService,
): RegisteredTool {
  return {
    id: 'workspace.list',
    name: 'List workspace files',
    description:
      'Lists real files and folders inside the mounted local workspace using relative paths.',
    risk: 'read',
    providerName: 'workspace_list',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional workspace-relative directory. Omit it to list the workspace root.',
        },
      },
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'List workspace files');
      const allowed = new Set(['path']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('List workspace files received an unsupported input field.');
      }
      const path =
        value.path === undefined ? '' : requireWorkspaceRelativePath(value.path, 'directory path');
      return service.list(path);
    },
  };
}

export function createWorkspaceReadTool(
  service: WorkspaceService = workspaceService,
): RegisteredTool {
  return {
    id: 'workspace.read',
    name: 'Read workspace file',
    description: 'Reads bounded UTF-8 text from one real file inside the mounted local workspace.',
    risk: 'read',
    providerName: 'workspace_read',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 1048576,
          description: 'Optional maximum UTF-8 bytes to read. Defaults to 204800.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Read workspace file');
      const allowed = new Set(['path', 'maxBytes']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('Read workspace file received an unsupported input field.');
      }
      return service.read(
        requireWorkspaceRelativePath(value.path, 'file path'),
        optionalBoundedInteger(value.maxBytes, 'maxBytes', 1, 1_048_576),
      );
    },
  };
}

export function createWorkspaceSearchTool(
  service: WorkspaceService = workspaceService,
): RegisteredTool {
  return {
    id: 'workspace.search',
    name: 'Search workspace',
    description:
      'Searches real relative file paths and bounded UTF-8 file contents inside the mounted workspace.',
    risk: 'read',
    providerName: 'workspace_search',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find in paths or UTF-8 file contents.' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Optional result limit. Defaults to 40.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Search workspace');
      const allowed = new Set(['query', 'maxResults']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('Search workspace received an unsupported input field.');
      }
      return service.search(
        requireWorkspaceQuery(value.query),
        optionalBoundedInteger(value.maxResults, 'maxResults', 1, 100),
      );
    },
  };
}

export function createWorkspaceDirectoryTool(
  service: WorkspaceService = workspaceService,
  onChanged: () => void = notifyWorkspaceChanged,
): RegisteredTool {
  return {
    id: 'workspace.mkdir',
    name: 'Create workspace directory',
    description:
      'Creates one real directory inside an existing workspace-relative parent directory.',
    risk: 'write',
    providerName: 'workspace_create_directory',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path to create.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Create workspace directory');
      if (Object.keys(value).some((key) => key !== 'path')) {
        throw new Error('Create workspace directory received an unsupported input field.');
      }
      const result = await service.createDirectory(
        requireWorkspaceRelativePath(value.path, 'directory path'),
      );
      onChanged();
      return result;
    },
  };
}

export function createWorkspaceWriteTool(
  service: WorkspaceService = workspaceService,
  onChanged: () => void = notifyWorkspaceChanged,
): RegisteredTool {
  return {
    id: 'workspace.write',
    name: 'Write workspace file',
    description:
      'Creates or explicitly overwrites one bounded UTF-8 file inside the mounted workspace.',
    risk: 'write',
    providerName: 'workspace_write_file',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: {
          type: 'string',
          description: 'Complete UTF-8 file content, limited to 1 MiB.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Must be true to replace an existing regular file. Defaults to false for create-only safety.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Write workspace file');
      const allowed = new Set(['path', 'content', 'overwrite']);
      if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new Error('Write workspace file received an unsupported input field.');
      }
      if (value.overwrite !== undefined && typeof value.overwrite !== 'boolean') {
        throw new Error('Write workspace file overwrite must be true or false.');
      }
      const result = await service.writeFile(
        requireWorkspaceRelativePath(value.path, 'file path'),
        requireWorkspaceFileContent(value.content),
        value.overwrite ?? false,
      );
      onChanged();
      return result;
    },
  };
}

export function createWorkspaceMoveTool(
  service: WorkspaceService = workspaceService,
  onChanged: () => void = notifyWorkspaceChanged,
): RegisteredTool {
  return {
    id: 'workspace.move',
    name: 'Move workspace entry',
    description:
      'Moves one real file or directory to a new workspace-relative path. The target must not already exist.',
    risk: 'write',
    providerName: 'workspace_move',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Current workspace-relative path.' },
        targetPath: { type: 'string', description: 'New workspace-relative path.' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Move workspace entry');
      if (Object.keys(value).some((key) => key !== 'sourcePath' && key !== 'targetPath')) {
        throw new Error('Move workspace entry received an unsupported input field.');
      }
      const sourcePath = requireWorkspaceRelativePath(value.sourcePath, 'source path');
      const targetPath = requireWorkspaceRelativePath(value.targetPath, 'target path');
      if (sourcePath === targetPath) throw new Error('Move source and target must be different.');
      const result = await service.move(sourcePath, targetPath);
      onChanged();
      return result;
    },
  };
}

export function createWorkspaceDeleteTool(
  service: WorkspaceService = workspaceService,
  onChanged: () => void = notifyWorkspaceChanged,
): RegisteredTool {
  return {
    id: 'workspace.delete',
    name: 'Delete workspace entry',
    description:
      'Deletes one real file or directory inside the mounted workspace. Directory deletion is recursive.',
    risk: 'write',
    providerName: 'workspace_delete',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path to delete.' } },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Delete workspace entry');
      if (Object.keys(value).some((key) => key !== 'path')) {
        throw new Error('Delete workspace entry received an unsupported input field.');
      }
      const result = await service.delete(requireWorkspaceRelativePath(value.path, 'path'));
      onChanged();
      return result;
    },
  };
}

export function createWorkspacePatchTool(
  service: WorkspaceService = workspaceService,
  onChanged: () => void = notifyWorkspaceChanged,
): RegisteredTool {
  return {
    id: 'workspace.patch',
    name: 'Apply workspace patch',
    description:
      'Applies a reviewed text change set only when the file still matches its original content.',
    risk: 'write',
    providerName: 'workspace_patch',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative text file path.' },
        expectedContent: { type: 'string', description: 'Exact content reviewed before editing.' },
        updatedContent: { type: 'string', description: 'Complete replacement text.' },
      },
      required: ['path', 'expectedContent', 'updatedContent'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input, 'Apply workspace patch');
      if (
        Object.keys(value).some(
          (key) => !['path', 'expectedContent', 'updatedContent'].includes(key),
        )
      ) {
        throw new Error('Apply workspace patch received an unsupported input field.');
      }
      const result = await service.applyPatch(
        requireWorkspaceRelativePath(value.path, 'file path'),
        requireWorkspaceFileContent(value.expectedContent),
        requireWorkspaceFileContent(value.updatedContent),
      );
      onChanged();
      return result;
    },
  };
}
