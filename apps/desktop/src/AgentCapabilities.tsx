import { skillOrigin, type SkillDefinition } from '@iris/skills';
import type { ToolDefinition } from '@iris/tools';

export interface CapabilityGroup {
  id: string;
  label: string;
  description: string;
  items: Array<{ id: string; name: string; description: string; meta: string }>;
}

export function capabilityGroups(tools: readonly ToolDefinition[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>();
  for (const tool of tools) {
    const mcp = tool.id.match(/^mcp\.([^.]+)\./);
    const id = mcp ? `mcp:${mcp[1]}` : (tool.id.split('.')[0] ?? 'iris');
    const label = mcp
      ? `MCP · ${mcp[1]}`
      : id === 'workspace'
        ? 'Workspace'
        : id === 'memory'
          ? 'Memory'
          : id === 'github'
            ? 'GitHub Operations'
            : id === 'web'
              ? 'Web & Search'
              : id === 'image'
                ? 'Image Generation'
                : id === 'browser'
                  ? 'Browser Automation'
                  : id === 'janitor'
                    ? 'Janitor Host Control'
                    : 'IRIS Core';
    const group = groups.get(id) ?? {
      id,
      label,
      description: mcp
        ? 'Tools advertised by this connected MCP server.'
        : id === 'web'
          ? 'Web search and full-page Firecrawl extraction tools.'
          : id === 'image'
            ? 'Multimodal image generation and synthesis tools.'
            : id === 'browser'
              ? 'Web page fetching and HTML structure inspection primitives.'
              : id === 'github'
                ? 'GitHub release management and issue triage tools.'
                : 'Built-in IRIS tools.',
      items: [],
    };
    group.items.push({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      meta: String(tool.risk ?? ''),
    });
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function skillGroups(skills: readonly SkillDefinition[]): CapabilityGroup[] {
  return ['local', 'imported'].flatMap((kind) => {
    const matches = skills.filter((skill) => skillOrigin(skill).kind === kind);
    return matches.length
      ? [
          {
            id: `skills:${kind}`,
            label: kind === 'local' ? 'Local skills' : 'Imported skills',
            description:
              kind === 'local'
                ? 'Skills authored in IRIS.'
                : 'Skills with recorded external provenance.',
            items: matches.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.summary || 'No summary.',
              meta: skill.enabled ? 'enabled' : 'disabled',
            })),
          },
        ]
      : [];
  });
}

export function CapabilityPicker({
  title,
  groups,
  selectedIds,
  onToggle,
  onGroupAuthority,
  onClose,
}: {
  title: string;
  groups: CapabilityGroup[];
  selectedIds: readonly string[];
  onToggle: (id: string, selected: boolean) => void;
  onGroupAuthority?: (
    group: CapabilityGroup,
    policy: 'ask' | 'allow-read' | 'allow-all' | 'deny',
  ) => void;
  onClose: () => void;
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="capability-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="capability-picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="capability-picker-heading">
          <div>
            <p className="eyebrow">Agent capabilities</p>
            <h3>{title}</h3>
          </div>
          <button className="row-button" onClick={onClose}>
            Done
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="agent-note">Nothing is available yet.</p>
        ) : (
          groups.map((group) => {
            const allSelected = group.items.every((item) => selected.has(item.id));
            return (
              <section className="capability-group" key={group.id}>
                <div className="capability-group-heading">
                  <div>
                    <strong>{group.label}</strong>
                    <small>{group.description}</small>
                  </div>
                  <div className="capability-group-actions">
                    <button
                      className="row-button"
                      onClick={() => group.items.forEach((item) => onToggle(item.id, !allSelected))}
                    >
                      {allSelected ? 'Clear all' : 'Select all'}
                    </button>
                    {onGroupAuthority && (
                      <select
                        aria-label={`${group.label} authority`}
                        defaultValue="ask"
                        onChange={(event) =>
                          onGroupAuthority(
                            group,
                            event.target.value as 'ask' | 'allow-read' | 'allow-all' | 'deny',
                          )
                        }
                      >
                        <option value="ask">Ask</option>
                        <option value="allow-read">Allow read</option>
                        <option value="allow-all">Allow read + write</option>
                        <option value="deny">Deny</option>
                      </select>
                    )}
                  </div>
                </div>
                <div className="capability-group-items">
                  {group.items.map((item) => (
                    <label className="capability-item" key={item.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={(event) => onToggle(item.id, event.target.checked)}
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                      <em>{item.meta}</em>
                    </label>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </section>
    </div>
  );
}
