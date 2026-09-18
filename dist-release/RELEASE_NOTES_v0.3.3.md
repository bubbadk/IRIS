# IRIS v0.3.3

IRIS v0.3.3 is a correctness patch. It fixes a startup failure that could make your agents and
permission rules look as if they had been deleted, and it makes the Agent workspace state a read
failure instead of staying silent.

Nothing about how IRIS stores your data changed. No stored value is rewritten, migrated or dropped
by this release.

## What was wrong

Since 0.3.0, an agent configuration or permission rule that referenced a tool identity the running
registry did not publish was treated as invalid configuration, and reading the agents failed.

The registry does not publish a tool while its provider is disconnected. IRIS connects to MCP
servers at startup, and the agent list was read at the same time — before those connections
finished. For anyone with MCP tools assigned to an agent, that meant:

- the Agents window stayed on "Loading agents…" or showed no agents at all,
- the permission rules failed to load in the same read, so tool authority was unavailable too,
- no message explained any of it, and the stored data was intact the whole time.

An expired OAuth token or an MCP server that is simply offline is enough to trigger it.

## What 0.3.3 changes

1. **An unavailable provider no longer invalidates an agent.** Configured tool identities are
   resolved without requiring that the provider is reachable right now. The assignment is kept and
   the identity is reported as unavailable.
2. **Durable data is never rewritten to match a temporary outage.** A tool identity that is already
   stored for an agent stays stored while its server is offline, and it works again when that
   server reconnects. One unreachable MCP server no longer hides the other agents.
3. **Writes stay exact.** A newly assigned tool identity must exist when it is saved; only
   identities an agent already carries survive an offline provider.
4. **The Agents window names what is unavailable.** A status line lists how many assigned tools are
   unavailable right now, which agent holds them, and that nothing was removed.
5. **A failed read explains itself.** If the agent workspace cannot be read at all, the window now
   shows the actual error with a "Try again" action, instead of an empty list that reads as lost
   data.

## Compatibility

- No change to stored formats, file locations, provider configuration or the updater.
- Existing agents, projects, schedules, memory, documents, knowledge, skills and permission rules
  load unchanged.
- Built-in tools are unaffected. Users who never assigned MCP tools to an agent were not affected
  by the original defect.

## Known limitations

- An agent cannot call a tool whose provider is not connected; the Agents window says so rather
  than hiding the agent.
- A tool identity that is unavailable is shown but cannot be run; the permission rule for it stays
  stored and applies again once the provider registers the tool.
- The other workspace windows read their own repositories; this release surfaces load failures in
  the Agent workspace only.
- `v0.3.0` and `v0.3.1` remain source tags with no published releases. They are left untouched.

## Verification

Verified on Linux (CachyOS / Arch family), the primary development environment:

| Suite                                   | Result                                     |
| :-------------------------------------- | :----------------------------------------- |
| TypeScript (`pnpm test`)                | 137 test files · 1428 passed · 0 failed    |
| Rust, Linux (`cargo test`)              | 128 passed · 0 failed · 13 ignored         |
| `pnpm typecheck`                        | 0 errors across all packages               |
| `pnpm lint`                             | 0 errors, 0 warnings across all packages   |

The regression is covered by tests in `packages/tools` (identity resolution, strict writes,
permission rules) and in `apps/desktop` (an agent with an unavailable provider still loads; the
Agents window renders a read failure and retries it).

## Publication

Publication of this release requires a fresh, explicit human approval for that exact invocation.
