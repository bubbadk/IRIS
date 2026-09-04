import type { ToolContext } from '@iris/tools';
import { diffWorkspaceText, type WorkspaceChange, type WorkspaceTextDiff } from '@iris/workspaces';
import { workspaceChangeRepository } from './persistence';
import { workspaceService } from './workspace';

export type RecordedWorkspaceChange = Omit<
  WorkspaceChange,
  'version' | 'id' | 'timestamp' | 'workspaceId' | 'agentId' | 'agentName' | 'turnId'
>;

export function replacementDiff(content: string): WorkspaceTextDiff {
  return diffWorkspaceText('', content, 160);
}

/**
 * Records a successful workspace mutation for the shared change stream. This audit aid is
 * deliberately best-effort: storage trouble must never turn a completed file mutation into a
 * false failure for the agent.
 */
export async function recordWorkspaceChange(
  context: ToolContext,
  change: RecordedWorkspaceChange,
): Promise<void> {
  try {
    const workspace = await workspaceService.current();
    if (!workspace) return;
    await workspaceChangeRepository.append({
      version: 1,
      id: `workspace-change-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      workspaceId: workspace.id,
      agentId: context.agentId,
      agentName: context.agentName,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...change,
    });
  } catch {
    // The actual workspace operation already succeeded; keep that truthful outcome intact.
  }
}
