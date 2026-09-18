import { webToolFetch } from './webFetch';
import { resolveProviderConnection } from './credentials';
import { createKnowledgeTools } from './knowledgeTools';
import { createDocumentTools } from './documentTools';
import type { AgentToolRuntime } from '@iris/agents';
import { delegatedExecutionResult } from './subagentTool';
import { loadProviderConfigs, type ProviderConfig } from '@iris/providers';
import {
  AuditedPermissionEngine,
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolPermissionError,
  createWebSearchTool,
  createWebExtractTool,
  createImageGenerationTool,
  type ImageProviderBinding,
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

function providerEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return '';
  }
}

/** The first-party host each image provider's own catalog identity unambiguously authorizes. */
const imageProviderHomeHost: Readonly<Record<'openai' | 'openrouter', string>> = {
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
};

/**
 * Whether one stored provider configuration speaks for an image provider IRIS can address.
 *
 * Classification uses the stored catalog identity and, for legacy documents that carry none, the
 * endpoint host the configuration itself names. Nothing here picks the destination: the endpoint of
 * the *selected* configuration does that, so classification can never move a credential to an
 * origin other than the one its own configuration authorizes.
 */
function imageProviderForConfig(config: ProviderConfig): 'openai' | 'openrouter' | undefined {
  if (!config.enabled) return undefined;
  const catalogId = config.catalogId?.trim().toLowerCase();
  const host = providerEndpointHost(config.endpoint);
  if (catalogId === 'openai' || host === imageProviderHomeHost.openai) return 'openai';
  if (catalogId === 'openrouter' || host === imageProviderHomeHost.openrouter) return 'openrouter';
  return undefined;
}

/**
 * Orders, deterministically, the provider configurations an image request may use.
 *
 *   1. configurations whose endpoint is the provider's own first-party host, sorted by id — the
 *      case where catalog identity and destination agree;
 *   2. every remaining candidate, sorted by id, so identical stored state always produces the same
 *      order instead of whichever entry happens to sit first in the stored array.
 *
 * The order decides *which configuration is tried*; it never decides the destination. Each
 * configuration still supplies both its own endpoint and its own credential.
 */
function imageProviderCandidates(providerName: 'openai' | 'openrouter'): ProviderConfig[] {
  const candidates = loadProviderConfigs()
    .filter((config) => imageProviderForConfig(config) === providerName)
    .sort((left, right) => left.id.localeCompare(right.id));
  const firstParty = candidates.filter(
    (config) => providerEndpointHost(config.endpoint) === imageProviderHomeHost[providerName],
  );
  return [...firstParty, ...candidates.filter((config) => !firstParty.includes(config))];
}

/**
 * The one trusted image-provider binding used by the production `image.generate` tool.
 *
 * The credential and the endpoint are read from the same selected configuration, and the credential
 * is resolved through the single precedence contract (`resolveProviderConnection`), so a stale
 * plaintext copy can never beat the keyring secret. The model chooses only the provider name and
 * the prompt; it can never contribute an endpoint or a key.
 */
async function imageProviderBindingResolver(
  providerName: 'openai' | 'openrouter',
): Promise<ImageProviderBinding | undefined> {
  for (const config of imageProviderCandidates(providerName)) {
    const resolved = await resolveProviderConnection(config);
    const apiKey = resolved.connectionValues?.apiKey?.trim();
    if (!apiKey) continue;
    return {
      configurationId: resolved.id,
      provider: providerName,
      endpoint: resolved.endpoint,
      apiKey,
    };
  }
  return undefined;
}

import { toolRegistry } from './toolRegistry';
export { toolRegistry } from './toolRegistry';
for (const tool of [...createDocumentTools(), ...createKnowledgeTools()])
  toolRegistry.register(tool);
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
toolRegistry.register(createWebSearchTool(webToolFetch));
toolRegistry.register(createWebExtractTool(webToolFetch));
toolRegistry.register(createImageGenerationTool(undefined, imageProviderBindingResolver));
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
  async execute(agent, toolName, input, invocation, signal, delegation) {
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
      result = await createToolExecutor(rules).execute(
        agent,
        tool.id,
        input,
        signal,
        invocation,
        delegation,
      );
    } catch (error) {
      if (error instanceof ToolPermissionError) {
        return { status: 'denied', reason: error.evaluation.reason };
      }
      throwIfAborted(error, signal);
      return { status: 'failed', reason: toolFailureReason(error) };
    }
    if (result.status === 'completed') return delegatedExecutionResult(result.output);
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
      ? delegatedExecutionResult(result.output)
      : { status: 'approval-denied' };
  },
};
