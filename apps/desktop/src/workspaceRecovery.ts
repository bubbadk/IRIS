import { invoke } from '@tauri-apps/api/core';
import type {
  WorkspaceIsolationStatus,
  WorkspaceRestorePoint,
  WorkspaceRestorePreview,
} from '@iris/workspaces';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The native workspace returned invalid recovery data.');
  return value as Record<string, unknown>;
}
function point(value: unknown): WorkspaceRestorePoint {
  const data = object(value);
  if (
    typeof data.id !== 'string' ||
    !data.id ||
    typeof data.path !== 'string' ||
    !data.path ||
    typeof data.createdAtMs !== 'number' ||
    !Number.isFinite(data.createdAtMs) ||
    data.createdAtMs < 0 ||
    !['ready', 'original', 'conflict', 'unavailable'].includes(String(data.state))
  )
    throw new Error('The native workspace returned an invalid restore point.');
  return {
    id: data.id,
    path: data.path,
    createdAtMs: data.createdAtMs,
    state: data.state as WorkspaceRestorePoint['state'],
  };
}

export const workspaceRecovery = {
  async isolation(): Promise<WorkspaceIsolationStatus> {
    const result = object(await invoke('workspace_shell_isolation_status'));
    if (typeof result.available !== 'boolean' || typeof result.detail !== 'string')
      throw new Error('Shell isolation status is unavailable.');
    return { available: result.available, detail: result.detail };
  },
  async list(): Promise<WorkspaceRestorePoint[]> {
    const result: unknown = await invoke('list_workspace_restore_points');
    if (!Array.isArray(result)) throw new Error('Restore-point history is unavailable.');
    return result.map(point);
  },
  async preview(id: string): Promise<WorkspaceRestorePreview> {
    const result = object(await invoke('preview_workspace_restore_point', { id }));
    const summary = point(result.summary);
    if (
      summary.id !== id ||
      (result.before !== null && typeof result.before !== 'string') ||
      typeof result.after !== 'string'
    )
      throw new Error('The restore preview does not match the requested file edit.');
    return { summary, before: result.before, after: result.after };
  },
  async restore(id: string): Promise<string> {
    const result: unknown = await invoke('restore_workspace_file', { id });
    if (typeof result !== 'string' || !result)
      throw new Error(
        'The native restore returned an invalid result. Inspect the file before retrying.',
      );
    return result;
  },
};
