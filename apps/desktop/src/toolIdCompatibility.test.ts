import { beforeEach, describe, expect, it } from 'vitest';
import { createDelegationContext, type AgentDefinition } from '@iris/core';
import { InvalidToolConfigurationError, StaticPermissionEngine } from '@iris/tools';
import { createSystemJanitorPreset, ONBOARDING_COMPLETED_KEY } from './OnboardingWizard';
import {
  createDefaultAgentTeam,
  standardGitHubTools,
  standardWorkspaceTools,
} from './agentPresets';
import {
  LocalAgentRepository,
  LocalPermissionRuleRepository,
} from './persistence';
import { toolRegistry } from './toolRegistry';
// Production registration order: everything except delegation registers in `tooling`; the
// delegation tools register at `agentRuntime` module scope. Configuration validation against the
// shared singleton must see exactly what the live runtime sees, so both are imported here.
import './tooling';
import './agentRuntime';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const janitorAgent: AgentDefinition = {
  id: 'agent-janitor',
  name: 'System Janitor',
  autonomy: 'janitor',
  skillIds: [],
  toolIds: ['janitor.health'],
};

const delegatedAgent: AgentDefinition = {
  ...janitorAgent,
  id: 'delegated-child',
  approvalMode: 'yolo' as const,
  toolIds: ['cortex.delegate-subagent'],
};

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

describe('legacy tool ID compatibility boundary', () => {
  it('maps a legacy subagent delegation ID to the registered canonical ID on load', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    await repository.save({
      ...janitorAgent,
      toolIds: ['subagent.delegate'],
    });
    expect(await repository.list()).toEqual([
      expect.objectContaining({ toolIds: ['cortex.delegate-subagent'] }),
    ]);
    expect(globalThis.localStorage.getItem('iris.agents.config.v2')).toContain(
      'cortex.delegate-subagent',
    );
  });

  it('maps a legacy janitor diagnostics ID to the registered health ID without widening', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    await repository.save({ ...janitorAgent, toolIds: ['janitor.diagnostics'] });
    const agents = await repository.list();
    expect(agents[0]?.toolIds).toEqual(['janitor.health']);
    expect(agents[0]?.toolIds).not.toContain('janitor.projectcockpit');
  });

  it('accepts canonical IDs unchanged and removes legacy names after one mapping', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    await repository.save({ ...janitorAgent, toolIds: ['cortex.delegate-subagent'] });
    const first = await repository.list();
    expect(first[0]?.toolIds).toEqual(['cortex.delegate-subagent']);
    expect(globalThis.localStorage.getItem('iris.agents.config.v2')).not.toContain('subagent.delegate');
    const second = await repository.list();
    expect(second).toEqual(first);
  });

  it('rewrites a stored legacy permission allow rule onto the canonical tool ID', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    await repository.save({
      id: 'legacy-allow',
      agentId: janitorAgent.id,
      toolId: 'subagent.delegate',
      decision: 'allow',
    });
    expect(await repository.list()).toEqual([
      expect.objectContaining({ id: 'legacy-allow', toolId: 'cortex.delegate-subagent', decision: 'allow' }),
    ]);
    expect(globalThis.localStorage.getItem('iris.permissions.rules.v1')).toContain(
      'cortex.delegate-subagent',
    );
  });

  it('keeps a legacy deny rule denying on the canonical tool ID', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    await repository.save({
      id: 'legacy-deny',
      agentId: janitorAgent.id,
      toolId: 'janitor.diagnostics',
      decision: 'deny',
      reason: 'Diagnostics are forbidden.',
    });
    const rules = await repository.list();
    expect(rules[0]?.toolId).toBe('janitor.health');
    expect(rules[0]?.decision).toBe('deny');
    const engine = new StaticPermissionEngine(rules);
    await expect(engine.evaluate(janitorAgent, toolRegistry.get('janitor.health')!)).resolves.toMatchObject({
      decision: 'deny',
      ruleId: 'legacy-deny',
    });
  });

  it('still evaluates a mapped legacy allow rule through delegation without widening it', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    await repository.save({
      id: 'legacy-allow',
      agentId: janitorAgent.id,
      toolId: 'subagent.delegate',
      decision: 'allow',
    });
    const rules = await repository.list();
    const engine = new StaticPermissionEngine(rules);
    const delegatedTool = toolRegistry.get('cortex.delegate-subagent')!;
    // A delegated child that carries the tool evaluates its ancestor's mapped canonical rule through
    // the trusted chain: the legacy name never appears in evaluation, only its canonical identity.
    await expect(
      engine.evaluate(
        delegatedAgent,
        delegatedTool,
        {
          source: 'execution',
          delegation: createDelegationContext({
            depth: 1,
            ancestors: [{ id: janitorAgent.id, approvalMode: 'ask' }],
          }),
        },
      ),
    ).resolves.toMatchObject({ decision: 'allow', ruleId: 'legacy-allow' });
    // A child the tool was never assigned to stays denied: neither the legacy name nor the
    // ancestor's allow rule can widen the child's own assignment (least privilege).
    await expect(
      engine.evaluate(
        { ...delegatedAgent, toolIds: [] },
        delegatedTool,
        {
          source: 'execution',
          delegation: createDelegationContext({
            depth: 1,
            ancestors: [{ id: janitorAgent.id, approvalMode: 'ask' }],
          }),
        },
      ),
    ).resolves.toMatchObject({ decision: 'deny' });
  });

  it('rejects an unknown tool ID as controlled invalid configuration', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    globalThis.localStorage.setItem(
      'iris.agents.config.v2',
      JSON.stringify([{ ...janitorAgent, toolIds: ['not.a.real.tool'] }]),
    );
    await expect(repository.list()).rejects.toThrow(/unknown or unavailable tool ID "not.a.real.tool"/);
  });

  it('rejects a rule that targets an unregistered tool ID as controlled invalid configuration', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    globalThis.localStorage.setItem(
      'iris.permissions.rules.v1',
      JSON.stringify([
        { id: 'r1', agentId: janitorAgent.id, toolId: 'ghost.tool', decision: 'ask' },
      ]),
    );
    await expect(repository.list()).rejects.toThrow(/unknown or unavailable tool ID "ghost.tool"/);
  });

  it('canonicalizes a saved legacy configuration and never writes the legacy ID back', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    await repository.save({ ...janitorAgent, toolIds: ['janitor.diagnostics', 'subagent.delegate'] });
    expect(globalThis.localStorage.getItem('iris.agents.config.v2')).not.toContain('janitor.diagnostics');
    expect(globalThis.localStorage.getItem('iris.agents.config.v2')).not.toContain('subagent.delegate');
    expect(await repository.get(janitorAgent.id)).toMatchObject({
      toolIds: ['janitor.health', 'cortex.delegate-subagent'],
    });
  });

  it('maps each legacy ID exactly once and is idempotent on repeated loads', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    await repository.save({ ...janitorAgent, toolIds: ['subagent.delegate', 'janitor.diagnostics'] });
    const first = await repository.list();
    const second = await repository.list();
    const third = await repository.list();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // Positional, one-to-one mapping: each legacy ID maps in place, order is preserved, and no
    // second registration or extra ID appears.
    expect(first[0]?.toolIds).toEqual(['cortex.delegate-subagent', 'janitor.health']);
  });

  it('rejects a mixed document that carries both a legacy and an unregistered ID', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    globalThis.localStorage.setItem(
      'iris.agents.config.v2',
      JSON.stringify([{ ...janitorAgent, toolIds: ['subagent.delegate', 'totally.unknown'] }]),
    );
    await expect(repository.list()).rejects.toThrow(/totally\.unknown/);
    // Controlled invalid: the legacy ID is not silently salvaged out of a broken document.
    expect(globalThis.localStorage.getItem('iris.agents.config.v2')).toContain('totally.unknown');
  });

  it('rejects two rules that disagree after mapping instead of silently picking one', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    await repository.save({ id: 'deny-rule', agentId: janitorAgent.id, toolId: 'subagent.delegate', decision: 'deny' });
    await expect(
      repository.save({ id: 'allow-rule', agentId: janitorAgent.id, toolId: 'cortex.delegate-subagent', decision: 'allow' }),
    ).rejects.toThrow(/conflicting permission rules/);
  });
});

describe('fresh onboarding System Janitor preset', () => {
  it('creates a runtime-valid janitor preset with registered tools and mandatory-approval command', () => {
    const preset = createSystemJanitorPreset('provider-1', 'test-model');
    expect(preset.autonomy).toBe('janitor');
    expect(preset.toolIds).toEqual([
      'janitor.health',
      'janitor.projectcockpit',
      'janitor.command',
      'memory.remember',
      'workspace.list',
      'workspace.read',
      'workspace.write',
    ]);
    for (const toolId of preset.toolIds) {
      expect(toolRegistry.get(toolId), `tool ${toolId} must be registered`).toBeDefined();
    }
    const command = toolRegistry.get('janitor.command');
    expect(command?.alwaysRequireApproval).toBe(true);
    expect(toolRegistry.get('janitor.health')?.alwaysRequireApproval).toBeFalsy();
  });

  it('contains no legacy janitor.diagnostics assignment', () => {
    const preset = createSystemJanitorPreset('provider-1', 'test-model');
    expect(preset.toolIds).not.toContain('janitor.diagnostics');
    expect(preset.toolIds).not.toContain('subagent.delegate');
    expect(ONBOARDING_COMPLETED_KEY).toBe('iris.onboarding.completed.v1');
  });

  it('evaluates janitor.command as approval-required for a fresh janitor under YOLO', async () => {
    const preset = createSystemJanitorPreset('provider-1', 'test-model');
    const yoloJanitor: AgentDefinition = { ...preset, approvalMode: 'yolo' as const };
    const engine = new StaticPermissionEngine([]);
    await expect(
      engine.evaluate(yoloJanitor, toolRegistry.get('janitor.command')!),
    ).resolves.toMatchObject({ decision: 'ask' });
    await expect(engine.evaluate(preset, toolRegistry.get('janitor.health')!)).resolves.toMatchObject({
      decision: 'deny',
    });
  });

  it('keeps a delegated janitor child from running the command unattended', async () => {
    const preset = createSystemJanitorPreset('provider-1', 'test-model');
    const delegated: AgentDefinition = { ...preset, id: 'child-janitor', approvalMode: 'yolo' as const };
    const engine = new StaticPermissionEngine([]);
    await expect(
      engine.evaluate(
        delegated,
        toolRegistry.get('janitor.command')!,
        { source: 'execution', delegation: { depth: 1, ancestors: [{ id: preset.id, approvalMode: 'yolo' }] } as never },
      ),
    ).resolves.toMatchObject({ decision: 'ask' });
  });
});

/**
 * F-1H release-blocker coverage. The fresh-install default team used tool IDs derived from the
 * factory names (`workspace.directory`, `host.inspect`) that the registry never published, so
 * `save()` and `list()` threw `InvalidToolConfigurationError` for the product's own preset.
 * These tests exercise the production preset and the production repository, so they fail if the
 * fresh preset ever drifts from the registry again or if legacy durable data stops being readable.
 */
describe('fresh-install preset is reconciled with the live tool registry', () => {
  it('assigns only registered canonical IDs to every preset a fresh install materialises', () => {
    const presets: Array<{ label: string; toolIds: readonly string[] }> = [
      ...createDefaultAgentTeam('provider-1', 'test-model').map((agent) => ({
        label: `default team member ${agent.name}`,
        toolIds: agent.toolIds,
      })),
      { label: 'standardWorkspaceTools', toolIds: standardWorkspaceTools },
      { label: 'standardGitHubTools', toolIds: standardGitHubTools },
    ];
    for (const preset of presets) {
      for (const toolId of preset.toolIds) {
        expect(
          toolRegistry.get(toolId),
          `${preset.label} references unregistered tool ${toolId}`,
        ).toBeDefined();
      }
    }
    const allIds = presets.flatMap((preset) => [...preset.toolIds]);
    expect(allIds).not.toContain('workspace.directory');
    expect(allIds).not.toContain('host.inspect');
  });

  it('creates the default team through the real repository and reads it after a restart', async () => {
    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    const team = createDefaultAgentTeam('provider-1', 'test-model');
    for (const agent of team) await repository.save(agent);

    const persisted = globalThis.localStorage.getItem('iris.agents.config.v2') ?? '';
    expect(persisted).not.toContain('workspace.directory');
    expect(persisted).not.toContain('host.inspect');

    // A restart is a new repository instance over the same durable storage.
    const restarted = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    const listed = await restarted.list();
    expect(listed.map((agent) => agent.id).sort()).toEqual(team.map((agent) => agent.id).sort());
    const coordinator = listed.find((agent) => agent.autonomy === 'operate');
    expect(coordinator?.toolIds).toEqual([...standardWorkspaceTools]);
    expect(toolRegistry.get('system.inspect-host')).toBeDefined();
  });

  it('reads durable agents that still carry the pre-rename IDs and re-saves canonical IDs', async () => {
    const legacyInstall: AgentDefinition = {
      ...janitorAgent,
      id: 'agent-legacy-install',
      autonomy: 'operate',
      toolIds: ['workspace.list', 'workspace.directory', 'host.inspect'],
    };
    globalThis.localStorage.setItem('iris.agents.config.v2', JSON.stringify([legacyInstall]));

    const repository = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    const agents = await repository.list();
    expect(agents[0]?.toolIds).toEqual(['workspace.list', 'workspace.mkdir', 'system.inspect-host']);

    await repository.save({ ...agents[0]!, name: 'Edited existing installation agent' });
    const persisted = JSON.parse(globalThis.localStorage.getItem('iris.agents.config.v2')!) as Array<{
      toolIds: string[];
    }>;
    expect(persisted[0]?.toolIds).toEqual(['workspace.list', 'workspace.mkdir', 'system.inspect-host']);
    expect(globalThis.localStorage.getItem('iris.agents.config.v2')).not.toContain('workspace.directory');
  });

  it('refuses to register a pre-rename ID as a second tool identity', () => {
    const canonical = toolRegistry.get('workspace.mkdir')!;
    expect(() => toolRegistry.register({ ...canonical, id: 'workspace.directory' })).toThrow(
      InvalidToolConfigurationError,
    );
    expect(toolRegistry.get('workspace.directory')).toBeUndefined();
    expect(toolRegistry.get('host.inspect')).toBeUndefined();
  });

  it('keeps a pre-rename deny rule denying on the canonical identity', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    await repository.save({
      id: 'legacy-workspace-deny',
      agentId: janitorAgent.id,
      toolId: 'workspace.directory',
      decision: 'deny',
      reason: 'Directory creation is forbidden.',
    });
    const rules = await repository.list();
    expect(rules[0]).toMatchObject({ toolId: 'workspace.mkdir', decision: 'deny' });
    const engine = new StaticPermissionEngine(rules);
    // The agent is assigned the canonical capability, so the mapped deny rule — not the
    // default-deny fallback — must decide.
    const assigned: AgentDefinition = {
      ...janitorAgent,
      toolIds: ['janitor.health', 'workspace.mkdir'],
    };
    await expect(
      engine.evaluate(assigned, toolRegistry.get('workspace.mkdir')!),
    ).resolves.toMatchObject({ decision: 'deny', ruleId: 'legacy-workspace-deny' });
  });

  it('does not let a pre-rename alias widen a delegated child past its own assignment', async () => {
    const repository = new LocalPermissionRuleRepository(globalThis.localStorage, toolRegistry);
    await repository.save({
      id: 'legacy-inspect-allow',
      agentId: janitorAgent.id,
      toolId: 'host.inspect',
      decision: 'allow',
    });
    const engine = new StaticPermissionEngine(await repository.list());
    const canonicalTool = toolRegistry.get('system.inspect-host')!;
    // The ancestor holds the mapped allow; a child that was never assigned the canonical tool
    // stays denied — the alias spelling cannot widen the child's authority.
    await expect(
      engine.evaluate(
        { ...delegatedAgent, toolIds: [] },
        canonicalTool,
        {
          source: 'execution',
          delegation: createDelegationContext({
            depth: 1,
            ancestors: [{ id: janitorAgent.id, approvalMode: 'ask' }],
          }),
        },
      ),
    ).resolves.toMatchObject({ decision: 'deny' });
  });
});
