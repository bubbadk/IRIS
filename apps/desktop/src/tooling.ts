import type { AgentToolRuntime } from '@iris/agents';
import {
  AuditedPermissionEngine,
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolPermissionError,
  ToolRegistry,
  createWebSearchTool,
  createWebExtractTool,
  createImageGenerationTool,
  type PermissionRule,
  type ToolExecutionResult,
} from '@iris/tools';
import { createHostInspectionTool } from './hostInspection';
import { createJanitorCommandTool } from './janitorTool';
import { createJanitorProjectCockpitTool } from './janitorProjectCockpitTool';
import { createJanitorDiagnosticsTool } from './janitorDiagnosticsTool';
import { memoryService } from './memory';
import { createRememberMemoryTool } from './memoryTool';
import { createCaptureSkillTool } from './skillTool';
import { skillService } from './skills';
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
import { createShellExecTool } from './shellTool';
import { createAllBrowserSessionTools } from './liveBrowserTools';
import { createAllGitHubTools } from './githubTools';
import {
  agentRepository,
  permissionAuditRepository,
  permissionRuleRepository,
  toolApprovalRepository,
} from './persistence';

export const janitorHealthToolId = 'janitor.health';

export const toolRegistry = new ToolRegistry();
toolRegistry.register(createHostInspectionTool());
toolRegistry.register(createJanitorCommandTool());
toolRegistry.register(createJanitorProjectCockpitTool());
toolRegistry.register(createJanitorDiagnosticsTool());
toolRegistry.register(createRememberMemoryTool(memoryService));
toolRegistry.register(createCaptureSkillTool(skillService, agentRepository));
toolRegistry.register(createWorkspaceListTool());
toolRegistry.register(createWorkspaceSearchTool());
toolRegistry.register(createWorkspaceReadTool());
toolRegistry.register(createWorkspaceDirectoryTool());
toolRegistry.register(createWorkspaceWriteTool());
toolRegistry.register(createWorkspaceMoveTool());
toolRegistry.register(createWorkspaceDeleteTool());
toolRegistry.register(createWorkspacePatchTool());
toolRegistry.register(createShellExecTool());
toolRegistry.register(createWebSearchTool());
toolRegistry.register(createWebExtractTool());
toolRegistry.register(createImageGenerationTool());
for (const tool of createAllBrowserSessionTools()) {
  toolRegistry.register(tool);
}
for (const tool of createAllGitHubTools()) {
  toolRegistry.register(tool);
}

export function createToolExecutor(rules: PermissionRule[]) {
  return new GatedToolExecutor(
    toolRegistry,
    new AuditedPermissionEngine(new StaticPermissionEngine(rules), permissionAuditRepository),
    toolApprovalRepository,
  );
}

function toolFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'The tool failed without returning a reason.';
}

function throwIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
}

export const agentToolRuntime: AgentToolRuntime = {
  definitions(agent) {
    return toolRegistry
      .list()
      .filter((tool) => agent.toolIds.includes(tool.id))
      .map((tool) => ({
        name: tool.providerName ?? tool.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
      }));
  },
  async execute(agent, toolName, input, invocation, signal) {
    const tool = toolRegistry
      .list()
      .find(
        (candidate) =>
          (candidate.providerName ?? candidate.id.replace(/[^a-zA-Z0-9_-]/g, '_')) === toolName,
      );
    if (!tool) throw new Error(`Model requested an unknown tool: ${toolName}`);
    if (tool.id.startsWith('janitor.') && agent.autonomy !== 'janitor') {
      return {
        status: 'denied',
        reason: 'Janitor tools are reserved for agents with Janitor autonomy.',
      };
    }
    if (tool.id.startsWith('github.') && agent.autonomy !== 'github') {
      return {
        status: 'denied',
        reason: 'GitHub tools are reserved for agents with GitHub autonomy.',
      };
    }
    const rules = await permissionRuleRepository.list();
    let result: ToolExecutionResult;
    try {
      result = await createToolExecutor(rules).execute(agent, tool.id, input, signal, invocation);
    } catch (error) {
      if (error instanceof ToolPermissionError) {
        return { status: 'denied', reason: error.evaluation.reason };
      }
      throwIfAborted(error, signal);
      return { status: 'failed', reason: toolFailureReason(error) };
    }
    if (result.status === 'completed') return result;
    return {
      status: 'approval-required',
      approval: {
        id: result.approval.id,
        toolId: result.approval.toolId,
        toolName: result.approval.toolName,
        reason: result.evaluation.reason,
      },
    };
  },
  async resolve(approvalId, decision, signal) {
    const rules = await permissionRuleRepository.list();
    const executor = createToolExecutor(rules);
    const approval = await toolApprovalRepository.get(approvalId);
    if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
    let result;
    try {
      result =
        decision === 'approve' && approval.status === 'approved'
          ? await executor.resume(approvalId, signal)
          : await executor.resolve(approvalId, decision, signal);
    } catch (error) {
      throwIfAborted(error, signal);
      return { status: 'failed', reason: toolFailureReason(error) };
    }
    return result.status === 'completed'
      ? { status: 'completed', output: result.output }
      : { status: 'approval-denied' };
  },
};
