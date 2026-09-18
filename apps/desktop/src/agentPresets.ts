import type { AgentDefinition } from '@iris/core';

/**
 * The one source of truth for the tool IDs a fresh installation assigns to its default agents.
 *
 * These are the *registered* canonical identities. Earlier revisions listed the IDs derived from
 * the tool factory names (`workspace.directory`, `host.inspect`), which the registry never
 * published; a fresh install could therefore not create its default team and durable data written
 * under those names could not be read. Onboarding, the runtime normaliser and the workspace
 * context all read this list, so a rename can no longer drift between them.
 */
export const standardWorkspaceTools: readonly string[] = [
  'workspace.list',
  'workspace.search',
  'workspace.read',
  'workspace.mkdir',
  'workspace.write',
  'workspace.patch',
  'workspace.move',
  'workspace.delete',
  'memory.remember',
  'system.inspect-host',
  'cortex.delegate-subagent',
];

export const standardGitHubTools: readonly string[] = [
  'github.list_repos',
  'github.get_repo',
  'github.create_repo',
  'github.create_release',
  'github.trigger_workflow',
  'github.get_workflow_status',
  'github.list_issues',
  'github.create_pull_request',
  'workspace.list',
  'workspace.search',
  'workspace.read',
  'workspace.write',
  'workspace.patch',
  'memory.remember',
];

/** Fresh setup assigns real tool identities; command execution still needs per-invocation approval. */
export function createSystemJanitorPreset(providerId: string, model: string): AgentDefinition {
  return {
    id: `agent-janitor-${crypto.randomUUID().slice(0, 8)}`,
    name: 'System Janitor',
    description: 'Monitors system health, cleans memory, and maintains workspaces.',
    persona: 'You are the System Janitor in IRIS. Your job is to keep the system healthy, consolidate long-term memories, and maintain workspace hygiene.',
    providerPolicyId: providerId,
    model,
    autonomy: 'janitor',
    skillIds: [],
    toolIds: [
      'janitor.health',
      'janitor.projectcockpit',
      'janitor.command',
      'memory.remember',
      'workspace.list',
      'workspace.read',
      'workspace.write',
    ],
  };
}

/**
 * The default agent team a fresh installation creates. Extracted from the onboarding component so
 * the exact production preset can be exercised by tests and validated against the live registry.
 */
export function createDefaultAgentTeam(providerId: string, model: string): AgentDefinition[] {
  return [
    {
      id: `agent-iris-${crypto.randomUUID().slice(0, 8)}`,
      name: 'IRIS Coordinator',
      description: 'Primary intelligent coordinator with spatial integration and sub-agent delegation.',
      persona:
        'You are IRIS (Intelligent Reasoning & Integration System). You are helpful, precise, and delegate to specialized sub-agents and tools effectively.',
      providerPolicyId: providerId,
      model,
      autonomy: 'operate',
      skillIds: [],
      toolIds: [...standardWorkspaceTools],
    },
    {
      id: `agent-dev-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Senior Developer',
      description: 'Specialist in code architecture, refactoring, diagnostics, and Git.',
      persona:
        'You are the Senior Developer Specialist in IRIS. You write clean, type-safe, and thoroughly tested code, strictly adhering to architecture rules and verifying patches with diffs.',
      providerPolicyId: providerId,
      model,
      autonomy: 'act',
      skillIds: [],
      toolIds: [...standardWorkspaceTools],
    },
    createSystemJanitorPreset(providerId, model),
  ];
}
