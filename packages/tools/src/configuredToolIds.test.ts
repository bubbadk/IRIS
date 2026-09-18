import { describe, expect, it } from 'vitest';
import {
  assertAvailableConfiguredToolIds,
  canonicalConfiguredToolIds,
  canonicalConfiguredPermissionRules,
  InvalidToolConfigurationError,
  resolveConfiguredToolIds,
  ToolRegistry,
  type RegisteredTool,
} from './index';

function tool(id: string): RegisteredTool {
  return {
    id,
    name: id,
    description: `${id} description`,
    risk: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    async run() {
      return null;
    },
  };
}

function registryWith(...ids: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  ids.forEach((id) => registry.register(tool(id)));
  return registry;
}

describe('configured tool identity resolution', () => {
  it('reports an identity the registry does not publish without dropping it', () => {
    const registry = registryWith('workspace.read');
    const resolved = resolveConfiguredToolIds(
      ['workspace.read', 'mcp.server-1.search_email', 'workspace.read'],
      registry,
    );
    expect(resolved.ids).toEqual(['workspace.read', 'mcp.server-1.search_email']);
    expect(resolved.unavailable).toEqual(['mcp.server-1.search_email']);
    // The read path keeps the assignment: an unreachable provider is not invalid configuration.
    expect(canonicalConfiguredToolIds(resolved.ids, registry)).toEqual(resolved.ids);
  });

  it('still translates retired identities at the configuration boundary', () => {
    const registry = registryWith('system.inspect-host', 'workspace.mkdir');
    expect(canonicalConfiguredToolIds(['host.inspect', 'workspace.directory'], registry)).toEqual([
      'system.inspect-host',
      'workspace.mkdir',
    ]);
  });

  it('refuses a newly assigned identity that does not exist now', () => {
    const registry = registryWith('workspace.read');
    expect(() => assertAvailableConfiguredToolIds(['workspace.read', 'ghost.tool'], registry)).toThrow(
      InvalidToolConfigurationError,
    );
    expect(() => assertAvailableConfiguredToolIds(['workspace.read'], registry)).not.toThrow();
  });

  it('lets an identity that was already assigned survive while its provider is offline', () => {
    const registry = registryWith('workspace.read');
    expect(() =>
      assertAvailableConfiguredToolIds(['workspace.read', 'ghost.tool'], registry, ['ghost.tool']),
    ).not.toThrow();
  });

  it('keeps a permission rule for an unpublished identity instead of discarding the decision', () => {
    const registry = registryWith('workspace.read');
    const rules = [
      { id: 'r1', agentId: 'a1', toolId: 'ghost.tool', decision: 'deny' as const },
      { id: 'r2', agentId: 'a1', toolId: 'workspace.directory', decision: 'ask' as const },
    ];
    expect(canonicalConfiguredPermissionRules(rules, registry)).toEqual([
      { id: 'r1', agentId: 'a1', toolId: 'ghost.tool', decision: 'deny' },
      { id: 'r2', agentId: 'a1', toolId: 'workspace.mkdir', decision: 'ask' },
    ]);
  });

  it('still rejects conflicting decisions for the same actor and identity', () => {
    const registry = registryWith('workspace.read');
    expect(() =>
      canonicalConfiguredPermissionRules(
        [
          { id: 'r1', agentId: 'a1', toolId: 'workspace.read', decision: 'allow' },
          { id: 'r2', agentId: 'a1', toolId: 'workspace.read', decision: 'deny' },
        ],
        registry,
      ),
    ).toThrow(/conflicting permission rules/);
  });
});
