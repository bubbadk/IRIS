export interface WorkspaceMount {
  version: 1;
  id: string;
  name: string;
  rootPath: string;
  connectedAt: string;
  verifiedAt: string;
}

export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink';

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: WorkspaceEntryKind;
  size?: number;
  modifiedAt?: string;
}

export interface WorkspaceListing {
  relativePath: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceTextFile {
  relativePath: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
}

export interface WorkspaceSearchMatch {
  relativePath: string;
  match: 'path' | 'content';
  line?: number;
  preview: string;
}

export interface WorkspaceSearchResult {
  query: string;
  matches: WorkspaceSearchMatch[];
  scannedEntries: number;
  truncated: boolean;
}

export interface WorkspaceMutationResult {
  relativePath: string;
  kind: 'file' | 'directory';
  created: boolean;
  bytesWritten?: number;
}

export interface WorkspaceMoveResult {
  sourcePath: string;
  targetPath: string;
  kind: 'file' | 'directory';
}

export interface WorkspaceDeleteResult {
  relativePath: string;
  kind: 'file' | 'directory';
}

export interface WorkspacePatchResult extends WorkspaceMutationResult {
  changed: boolean;
}

export type WorkspaceDiffLineKind = 'context' | 'addition' | 'deletion';

export interface WorkspaceDiffLine {
  kind: WorkspaceDiffLineKind;
  text: string;
}

export interface WorkspaceTextDiff {
  changed: boolean;
  lines: WorkspaceDiffLine[];
  truncated: boolean;
}

export type WorkspaceChangeKind =
  | 'directory-created'
  | 'file-written'
  | 'moved'
  | 'deleted'
  | 'patched';

export interface WorkspaceChange {
  version: 1;
  id: string;
  timestamp: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  turnId?: string;
  kind: WorkspaceChangeKind;
  path: string;
  previousPath?: string;
  bytesWritten?: number;
  diff?: WorkspaceTextDiff;
}

export interface WorkspaceChangeRepository {
  list(workspaceId?: string): Promise<WorkspaceChange[]>;
  append(change: WorkspaceChange): Promise<void>;
  clear(workspaceId?: string): Promise<void>;
}

export interface WorkspaceRepository {
  get(): Promise<WorkspaceMount | null>;
  save(mount: WorkspaceMount): Promise<void>;
  clear(): Promise<void>;
}

export interface WorkspaceGitStatus {
  isGitRepo: boolean;
  branch: string;
  hasChanges: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  stagedFiles: string[];
  ahead: number;
  behind: number;
}

export interface WorkspaceService {
  current(): Promise<WorkspaceMount | null>;
  mount(rootPath: string): Promise<WorkspaceMount>;
  unmount(): Promise<void>;
  list(relativePath?: string): Promise<WorkspaceListing>;
  read(relativePath: string, maxBytes?: number): Promise<WorkspaceTextFile>;
  search(query: string, maxResults?: number): Promise<WorkspaceSearchResult>;
  createDirectory(relativePath: string): Promise<WorkspaceMutationResult>;
  writeFile(
    relativePath: string,
    content: string,
    overwrite?: boolean,
  ): Promise<WorkspaceMutationResult>;
  move(sourcePath: string, targetPath: string): Promise<WorkspaceMoveResult>;
  delete(relativePath: string): Promise<WorkspaceDeleteResult>;
  applyPatch(
    relativePath: string,
    expectedContent: string,
    updatedContent: string,
  ): Promise<WorkspacePatchResult>;
  gitStatus?(): Promise<WorkspaceGitStatus>;
}

export function cloneWorkspaceMount(mount: WorkspaceMount): WorkspaceMount {
  return { ...mount };
}

export function cloneWorkspaceChange(change: WorkspaceChange): WorkspaceChange {
  return {
    ...change,
    diff: change.diff
      ? { ...change.diff, lines: change.diff.lines.map((line) => ({ ...line })) }
      : undefined,
  };
}

export function validateWorkspaceChange(value: unknown): value is WorkspaceChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Partial<WorkspaceChange>;
  const validKinds: WorkspaceChangeKind[] = [
    'directory-created',
    'file-written',
    'moved',
    'deleted',
    'patched',
  ];
  const hasValidDiff =
    change.diff === undefined ||
    (typeof change.diff === 'object' &&
      typeof change.diff.changed === 'boolean' &&
      Array.isArray(change.diff.lines) &&
      typeof change.diff.truncated === 'boolean' &&
      change.diff.lines.every(
        (line) =>
          line &&
          typeof line === 'object' &&
          ['context', 'addition', 'deletion'].includes((line as WorkspaceDiffLine).kind) &&
          typeof (line as WorkspaceDiffLine).text === 'string',
      ));
  return (
    change.version === 1 &&
    typeof change.id === 'string' &&
    Boolean(change.id.trim()) &&
    typeof change.timestamp === 'string' &&
    Boolean(change.timestamp) &&
    typeof change.workspaceId === 'string' &&
    Boolean(change.workspaceId.trim()) &&
    typeof change.agentId === 'string' &&
    Boolean(change.agentId.trim()) &&
    typeof change.agentName === 'string' &&
    Boolean(change.agentName.trim()) &&
    typeof change.path === 'string' &&
    Boolean(change.path.trim()) &&
    typeof change.kind === 'string' &&
    validKinds.includes(change.kind as WorkspaceChangeKind) &&
    (change.previousPath === undefined || typeof change.previousPath === 'string') &&
    (change.turnId === undefined || typeof change.turnId === 'string') &&
    (change.bytesWritten === undefined || Number.isFinite(change.bytesWritten)) &&
    hasValidDiff
  );
}

export function validateWorkspaceMount(value: unknown): value is WorkspaceMount {
  if (!value || typeof value !== 'object') return false;
  const mount = value as Partial<WorkspaceMount>;
  return (
    mount.version === 1 &&
    typeof mount.id === 'string' &&
    Boolean(mount.id.trim()) &&
    typeof mount.name === 'string' &&
    Boolean(mount.name.trim()) &&
    typeof mount.rootPath === 'string' &&
    Boolean(mount.rootPath.trim()) &&
    typeof mount.connectedAt === 'string' &&
    Boolean(mount.connectedAt) &&
    typeof mount.verifiedAt === 'string' &&
    Boolean(mount.verifiedAt)
  );
}

export function requireWorkspaceRelativePath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string') throw new Error(`Workspace ${label} must be text.`);
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized) throw new Error(`Workspace ${label} is required.`);
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`Workspace ${label} must stay inside the mounted workspace.`);
  }
  return normalized;
}

export function requireWorkspaceQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Workspace search requires a query.');
  }
  const query = value.trim();
  if (query.length > 200) throw new Error('Workspace search query is too long.');
  return query;
}

export function requireWorkspaceFileContent(value: unknown, maxBytes = 1_048_576): string {
  if (typeof value !== 'string') throw new Error('Workspace file content must be text.');
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maxBytes) {
    throw new Error(`Workspace file content exceeds the ${maxBytes} byte write limit.`);
  }
  return value;
}

export function diffWorkspaceText(
  original: string,
  updated: string,
  maxLines = 2000,
): WorkspaceTextDiff {
  const before = original.split('\n');
  const after = updated.split('\n');
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: WorkspaceDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (lines.length >= maxLines) return { changed: original !== updated, lines, truncated: true };
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push({ kind: 'context', text: `  ${before[i]}` });
      i += 1;
      j += 1;
    } else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push({ kind: 'addition', text: `+ ${after[j]}` });
      j += 1;
    } else {
      lines.push({ kind: 'deletion', text: `- ${before[i]}` });
      i += 1;
    }
  }
  return { changed: original !== updated, lines, truncated: false };
}
