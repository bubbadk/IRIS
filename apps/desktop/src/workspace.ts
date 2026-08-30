import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { AgentSystemContextBuilder } from '@iris/agents';
import type {
  WorkspaceEntry,
  WorkspaceListing,
  WorkspaceMount,
  WorkspaceMutationResult,
  WorkspaceMoveResult,
  WorkspaceDeleteResult,
  WorkspacePatchResult,
  WorkspaceRepository,
  WorkspaceSearchResult,
  WorkspaceService,
  WorkspaceTextFile,
  WorkspaceGitStatus,
} from '@iris/workspaces';
import { isTauriRuntime } from './credentials';
import { workspaceRepository } from './persistence';

type InvokeArguments = Record<string, unknown>;

export interface NativeWorkspaceDependencies {
  available: () => boolean;
  invokeNative: (command: string, args?: InvokeArguments) => Promise<unknown>;
  now: () => Date;
  createId: () => string;
}

const defaultDependencies: NativeWorkspaceDependencies = {
  available: isTauriRuntime,
  invokeNative: (command, args) => invoke(command, args),
  now: () => new Date(),
  createId: () => `workspace-${crypto.randomUUID()}`,
};

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The native workspace returned invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`The native workspace returned invalid ${label}.`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`The native workspace returned invalid ${label}.`);
  }
  return value;
}

function parseNativeMount(value: unknown): { name: string; rootPath: string } {
  const mount = objectValue(value, 'mount');
  return {
    name: requiredText(mount.name, 'workspace name'),
    rootPath: requiredText(mount.rootPath, 'workspace root'),
  };
}

function parseEntry(value: unknown): WorkspaceEntry {
  const entry = objectValue(value, 'entry');
  const kind = entry.kind;
  if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') {
    throw new Error('The native workspace returned an invalid entry kind.');
  }
  const modifiedAtMs = optionalNumber(entry.modifiedAtMs, 'modified timestamp');
  return {
    name: requiredText(entry.name, 'entry name'),
    relativePath: requiredText(entry.relativePath, 'entry path'),
    kind,
    ...(optionalNumber(entry.size, 'entry size') !== undefined
      ? { size: optionalNumber(entry.size, 'entry size') }
      : {}),
    ...(modifiedAtMs !== undefined ? { modifiedAt: new Date(modifiedAtMs).toISOString() } : {}),
  };
}

function parseListing(value: unknown): WorkspaceListing {
  const listing = objectValue(value, 'listing');
  if (!Array.isArray(listing.entries) || typeof listing.truncated !== 'boolean') {
    throw new Error('The native workspace returned an invalid listing.');
  }
  return {
    relativePath:
      typeof listing.relativePath === 'string'
        ? listing.relativePath
        : requiredText(listing.relativePath, 'listing path'),
    entries: listing.entries.map(parseEntry),
    truncated: listing.truncated,
  };
}

function parseTextFile(value: unknown): WorkspaceTextFile {
  const file = objectValue(value, 'file');
  if (typeof file.content !== 'string' || typeof file.truncated !== 'boolean') {
    throw new Error('The native workspace returned invalid file content.');
  }
  return {
    relativePath: requiredText(file.relativePath, 'file path'),
    content: file.content,
    bytesRead: optionalNumber(file.bytesRead, 'file byte count') ?? 0,
    truncated: file.truncated,
  };
}

function parseSearchResult(value: unknown): WorkspaceSearchResult {
  const result = objectValue(value, 'search result');
  if (
    !Array.isArray(result.matches) ||
    typeof result.truncated !== 'boolean' ||
    typeof result.scannedEntries !== 'number'
  ) {
    throw new Error('The native workspace returned an invalid search result.');
  }
  return {
    query: requiredText(result.query, 'search query'),
    matches: result.matches.map((value) => {
      const match = objectValue(value, 'search match');
      if (match.match !== 'path' && match.match !== 'content') {
        throw new Error('The native workspace returned an invalid search match type.');
      }
      return {
        relativePath: requiredText(match.relativePath, 'search match path'),
        match: match.match,
        ...(optionalNumber(match.line, 'search line') !== undefined
          ? { line: optionalNumber(match.line, 'search line') }
          : {}),
        preview: typeof match.preview === 'string' ? match.preview : '',
      };
    }),
    scannedEntries: optionalNumber(result.scannedEntries, 'scanned entry count') ?? 0,
    truncated: result.truncated,
  };
}

function parseMutationResult(value: unknown): WorkspaceMutationResult {
  const result = objectValue(value, 'mutation result');
  if (
    (result.kind !== 'file' && result.kind !== 'directory') ||
    typeof result.created !== 'boolean'
  ) {
    throw new Error('The native workspace returned an invalid mutation result.');
  }
  return {
    relativePath: requiredText(result.relativePath, 'mutation path'),
    kind: result.kind,
    created: result.created,
    ...(optionalNumber(result.bytesWritten, 'written byte count') !== undefined
      ? { bytesWritten: optionalNumber(result.bytesWritten, 'written byte count') }
      : {}),
  };
}

function parseMoveResult(value: unknown): WorkspaceMoveResult {
  const result = objectValue(value, 'move result');
  if (result.kind !== 'file' && result.kind !== 'directory') {
    throw new Error('The native workspace returned an invalid move kind.');
  }
  return {
    sourcePath: requiredText(result.sourcePath, 'move source path'),
    targetPath: requiredText(result.targetPath, 'move target path'),
    kind: result.kind,
  };
}

function parseDeleteResult(value: unknown): WorkspaceDeleteResult {
  const result = objectValue(value, 'delete result');
  if (result.kind !== 'file' && result.kind !== 'directory') {
    throw new Error('The native workspace returned an invalid delete kind.');
  }
  return { relativePath: requiredText(result.relativePath, 'delete path'), kind: result.kind };
}

function parsePatchResult(value: unknown): WorkspacePatchResult {
  const result = parseMutationResult(value);
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).changed !== 'boolean'
  ) {
    throw new Error('The native workspace returned an invalid patch result.');
  }
  return { ...result, changed: (value as Record<string, unknown>).changed as boolean };
}

export class NativeWorkspaceService implements WorkspaceService {
  private activeRoot: string | null = null;

  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly dependencies: NativeWorkspaceDependencies = defaultDependencies,
  ) {}

  async current(): Promise<WorkspaceMount | null> {
    const configured = await this.repository.get();
    if (!configured || !this.dependencies.available()) return configured;
    return this.mount(configured.rootPath);
  }

  async mount(rootPath: string): Promise<WorkspaceMount> {
    if (!this.dependencies.available()) {
      throw new Error('Local workspaces are available only in the native IRIS desktop app.');
    }
    const requestedPath = rootPath.trim();
    if (!requestedPath) throw new Error('Choose a local workspace folder first.');
    const native = parseNativeMount(
      await this.dependencies.invokeNative('mount_workspace', { rootPath: requestedPath }),
    );
    const existing = await this.repository.get();
    const timestamp = this.dependencies.now().toISOString();
    const mount: WorkspaceMount = {
      version: 1,
      id: existing?.rootPath === native.rootPath ? existing.id : this.dependencies.createId(),
      name: native.name,
      rootPath: native.rootPath,
      connectedAt: existing?.rootPath === native.rootPath ? existing.connectedAt : timestamp,
      verifiedAt: timestamp,
    };
    await this.repository.save(mount);
    this.activeRoot = mount.rootPath;
    return mount;
  }

  async unmount(): Promise<void> {
    if (this.dependencies.available()) {
      await this.dependencies.invokeNative('unmount_workspace');
    }
    await this.repository.clear();
    this.activeRoot = null;
  }

  async list(relativePath = ''): Promise<WorkspaceListing> {
    await this.requireMounted();
    return parseListing(await this.dependencies.invokeNative('list_workspace', { relativePath }));
  }

  async read(relativePath: string, maxBytes?: number): Promise<WorkspaceTextFile> {
    await this.requireMounted();
    return parseTextFile(
      await this.dependencies.invokeNative('read_workspace_file', {
        relativePath,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }),
    );
  }

  async search(query: string, maxResults?: number): Promise<WorkspaceSearchResult> {
    await this.requireMounted();
    return parseSearchResult(
      await this.dependencies.invokeNative('search_workspace', {
        query,
        ...(maxResults === undefined ? {} : { maxResults }),
      }),
    );
  }

  async createDirectory(relativePath: string): Promise<WorkspaceMutationResult> {
    await this.requireMounted();
    return parseMutationResult(
      await this.dependencies.invokeNative('create_workspace_directory', { relativePath }),
    );
  }

  async writeFile(
    relativePath: string,
    content: string,
    overwrite = false,
  ): Promise<WorkspaceMutationResult> {
    await this.requireMounted();
    return parseMutationResult(
      await this.dependencies.invokeNative('write_workspace_file', {
        relativePath,
        content,
        overwrite,
      }),
    );
  }

  async move(sourcePath: string, targetPath: string): Promise<WorkspaceMoveResult> {
    await this.requireMounted();
    return parseMoveResult(
      await this.dependencies.invokeNative('move_workspace_entry', { sourcePath, targetPath }),
    );
  }

  async delete(relativePath: string): Promise<WorkspaceDeleteResult> {
    await this.requireMounted();
    return parseDeleteResult(
      await this.dependencies.invokeNative('delete_workspace_entry', { relativePath }),
    );
  }

  async applyPatch(
    relativePath: string,
    expectedContent: string,
    updatedContent: string,
  ): Promise<WorkspacePatchResult> {
    await this.requireMounted();
    return parsePatchResult(
      await this.dependencies.invokeNative('apply_workspace_patch', {
        relativePath,
        expectedContent,
        updatedContent,
      }),
    );
  }

  async gitStatus(): Promise<WorkspaceGitStatus> {
    await this.requireMounted();
    const result = await this.dependencies.invokeNative('workspace_git_status');
    const obj = (result && typeof result === 'object' ? result : {}) as Partial<WorkspaceGitStatus>;
    return {
      isGitRepo: Boolean(obj.isGitRepo),
      branch: typeof obj.branch === 'string' ? obj.branch : 'main',
      hasChanges: Boolean(obj.hasChanges),
      modifiedFiles: Array.isArray(obj.modifiedFiles) ? obj.modifiedFiles : [],
      untrackedFiles: Array.isArray(obj.untrackedFiles) ? obj.untrackedFiles : [],
      stagedFiles: Array.isArray(obj.stagedFiles) ? obj.stagedFiles : [],
      ahead: typeof obj.ahead === 'number' ? obj.ahead : 0,
      behind: typeof obj.behind === 'number' ? obj.behind : 0,
    };
  }

  private async requireMounted(): Promise<WorkspaceMount> {
    if (!this.dependencies.available()) {
      throw new Error('Local workspace access is available only in the native IRIS desktop app.');
    }
    const configured = await this.repository.get();
    if (!configured) throw new Error('No local workspace is mounted.');
    return this.ensureMounted(configured);
  }

  private async ensureMounted(configured: WorkspaceMount): Promise<WorkspaceMount> {
    if (this.activeRoot === configured.rootPath) return configured;
    return this.mount(configured.rootPath);
  }
}

export const workspaceService = new NativeWorkspaceService(workspaceRepository);

const listeners = new Set<() => void>();

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyWorkspaceChanged(): void {
  listeners.forEach((listener) => listener());
}

export async function mountWorkspace(rootPath: string): Promise<WorkspaceMount> {
  const mount = await workspaceService.mount(rootPath);
  notifyWorkspaceChanged();
  return mount;
}

export async function unmountWorkspace(): Promise<void> {
  await workspaceService.unmount();
  notifyWorkspaceChanged();
}

export async function chooseWorkspaceFolder(): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new Error('Folder selection is available only in the native IRIS desktop app.');
  }
  const selected = await open({ directory: true, multiple: false, title: 'Choose IRIS workspace' });
  return typeof selected === 'string' ? selected : null;
}

const workspaceToolIds = new Set([
  'workspace.list',
  'workspace.search',
  'workspace.read',
  'workspace.directory',
  'workspace.write',
  'workspace.move',
  'workspace.delete',
  'workspace.patch',
]);

export function createAgentWorkspaceContext(
  repository: WorkspaceRepository,
  service: WorkspaceService,
): AgentSystemContextBuilder {
  return {
    async build(agent) {
      const configured = await repository.get();
      if (!configured) {
        return [
          'IRIS workspace state: No local workspace is mounted. Say that clearly if asked; do not claim that no workspace feature exists.',
        ];
      }
      try {
        const mount = await service.current();
        if (!mount) {
          return ['IRIS workspace state: No local workspace is mounted.'];
        }
        const assignedTools = agent.toolIds.filter((toolId) => workspaceToolIds.has(toolId));
        return assignedTools.length > 0
          ? [
              `IRIS workspace state: The local workspace “${mount.name}” is mounted at “${mount.rootPath}”. This agent has these workspace tools assigned: ${assignedTools.join(', ')}. Use only assigned tools and workspace-relative paths; never invent file access or results.\n\nACTION DIRECTIVE: When the user asks to create, write, generate, build, edit, or patch files or scripts in the workspace, you MUST immediately execute the corresponding tool call (such as \`workspace_write\` or \`workspace_patch\`) in your response turn. Do not merely state that you will write the file in text without executing the tool call.`,
            ]
          : [
              `IRIS workspace state: The local workspace “${mount.name}” is mounted at “${mount.rootPath}”, but this agent has no workspace tools assigned. State that access limitation instead of claiming there is no workspace.`,
            ];
      } catch (error) {
        return [
          `IRIS workspace state: A local workspace is configured but currently unavailable (${error instanceof Error ? error.message : String(error)}). Do not claim file access.`,
        ];
      }
    },
  };
}

export const agentWorkspaceContext = createAgentWorkspaceContext(
  workspaceRepository,
  workspaceService,
);
