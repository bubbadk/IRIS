# IRIS Current State

Status: **IRIS v0.2.0 – GitHub Operating Environment & Autonomous Versioning Live**

- Full GitHub Operating Environment integrated into left dock and window system (`GitHubState.tsx`).
- New `@iris/github` domain package with GitHub REST service, SemVer bumping, changelog generators, and automated release pipeline dispatch.
- New `github` Agent Autonomy profile with standard tool suite (`github.list_repos`, `github.get_repo`, `github.create_repo`, `github.create_release`, `github.trigger_workflow`, `github.get_workflow_status`, `github.list_issues`, `github.create_pull_request`).
- Multi-step "New Project Walkthrough" guide from local workspace development to initial push and live automated versioning.
- Public GitHub release `v0.1.0-alpha` published with production binary bundle `iris-v0.1.0-alpha-linux-x86_64.tar.gz`.
- Repository validation is 100% green: 37 test suites (190 tests), 26 Rust tests, ESLint, strict TypeScript, and production binary build.
- Spatial Glass Capsule HUD Desklet fully implemented with live status pulse, specialist activity feed, and system telemetry.
- In-app update notification modal and 3-step onboarding wizard with automatic existing-data detection.

## Working foundation

- pnpm monorepo structure.
- React + TypeScript desktop frontend.
- Tauri 2 native shell configuration.
- Linux desktop startup keeps hardware DMA-BUF transport on non-NVIDIA X11 and uses shared-memory transport
  with NVIDIA or Wayland, preserving GPU compositing while avoiding rejected GBM buffers; explicit overrides
  remain available.
- Initial IRIS object desktop with a calm light visual system.
- Desktop har en lokal, persisted dark mode-toggle øverst til højre; den skifter de centrale shell-, vindues-,
  chat- og formularflader til en afdæmpet mørk variant uden at ændre runtime-logik.
- Dark mode følger nu også de øvrige desktop-objekter og overlays, herunder Workspace, Agents, Projects,
  Schedules, Memory, MCP, permissions, lister, kort, previews og inputfelter.
- Movable and resizable object windows use frame-scheduled direct interaction rendering and commit layout
  state and persistence only when an interaction ends.
- Functional dock and command launcher for opening system objects.
- Desktop har en flydende "🛸 Desklet" widget-mode, der komprimerer hele arbejdspladsen til en minimalistisk,
  svævende live HUD på skrivebordet med realtids telemetri, live agent-puls og et-klik-genskabelse.
- Tauri native shell understøtter nu baggrunds-daemon via System Tray (proceslinje-ikon) og aflytning af
  `WindowEvent::CloseRequested` (`prevent_close` + `hide`), så agenter, planlagte opgaver (Schedules) og
  baggrundsprocesser (Dreaming) fortsætter uafbrudt i baggrunden, når hovedvinduet lukkes.
- Central desktop chat uses the same persisted agent runtime as Agents, with agent selection, a larger
  composer, clickable assistant URLs, readable MCP command labels, auto-following streamed replies,
  local history, Clear return to the default command-field desktop, and `/skill` plus `/mcp` slash
  suggestions from assigned capabilities; active chat is a broad top-to-bottom primary surface with
  a light translucent boundary, behind any opened object windows and above the desktop dock.
- Central desktop chat shows live thinking/tool activity status while a model or permission-gated tool
  is working, so an empty conversation surface no longer hides an active turn.
- Central desktop chat restores persisted pending approvals after restart or agent switching, including
  the requested tool input and approve/deny actions, instead of locking the composer behind an invisible approval.
- Clear remains available while a persisted approval is pending; it cancels that suspended turn safely,
  removes its approval state and then clears conversation/context records so the composer cannot stay locked.
- Central chat exposes live Stop and Allow for this agent actions: Stop aborts active model work or cancels
  a pending approval, while Allow persists an explicit per-agent tool rule so repetitive approvals are optional.
- Agents have a persisted per-agent YOLO approval mode. It allows assigned tools without repeated approvals,
  keeps unassigned tools blocked, preserves explicit Deny rules, and remains covered by permission auditing;
  existing agents default to Ask.
- Core domain, agent, provider and cortex contracts started as framework-independent packages.
- CachyOS setup helper.
- Local AppImage build command plus reproducible Debian 12 container build path; the container path is
  non-interactive and includes `xdg-utils`, and it has produced a verified x86_64 AppImage release artifact.
- GitHub Actions AppImage build definition for future repository use.
- Graphical provider configuration backed by a validated, locally cached models.dev directory; the
  current sync exposes all 203 directory entries plus IRIS local/custom entries.
- 195 current catalog entries are executable through OpenAI-compatible, Anthropic Messages, Gemini,
  Cohere Chat v2, Azure OpenAI or Ollama adapters. Entries needing other auth/runtime protocols remain
  visible and cannot be added; the UI states the missing adapter instead of simulating support.
- Native Anthropic, Gemini and Cohere adapters implement model discovery, streaming text and tool-call
  normalization with their protocol-specific endpoints and credential headers.
- OpenAI-compatible SSE parsing ignores standard event/comment metadata lines, preventing provider-specific
  stream framing from surfacing as misleading JSON parse failures.
- Native Azure OpenAI support uses an explicit resource endpoint, deployment name, stable API version,
  `api-key` authentication, catalog discovery and deployment-scoped streaming/tool calls.
- Provider secrets use versioned structured records in the OS keyring; legacy plaintext API keys migrate
  in memory, while non-secret connection fields remain local provider metadata.
- Native credential saves are accepted only after an immediate keyring read-back; browser preview keeps
  secrets in memory for the active session, and persistence never infers a stored-secret marker from form data.
- Built-in local entries cover Ollama, LM Studio, LocalAI, vLLM and llama.cpp.
- A built-in Antigravity (agy) entry targets the user's local OpenAI-compatible `agy` CLI shim at
  `127.0.0.1:8788` (no credential needed) for Gemini/Claude/GPT-OSS through their Antigravity
  subscription; the catalog description states plainly that the shim never returns tool calls, so
  agents on this provider get chat/reasoning only.
- Provider save and explicit refresh load real model identifiers from provider discovery endpoints;
  no static model catalog is presented as runtime availability.
- Discovered model lists and refresh timestamps persist as non-secret metadata, while multiple provider
  configurations remain available together and update open agent configuration views.
- Failed model discovery preserves an honest unavailable provider state and requires an explicit manual
  model before agents can use it.
- Non-secret provider metadata persists locally; API keys use OS keyring in the desktop app.
- Replaceable provider registry boundary with real endpoint connection testing.
- Tauri credential commands backed by the platform keyring for provider secrets.
- First real streaming model adapter for OpenAI-compatible SSE and Ollama NDJSON responses.
- Default browser transports preserve the native fetch receiver for real provider and embedding requests.
- Framework-independent agent sessions with conversation history and streaming events.
- Repository-backed local agent definitions and per-agent conversation persistence.
- Agent persistence validates runtime configuration at the storage boundary, migrates valid legacy records,
  repairs partially malformed current records and returns defensive capability arrays; invalid writes are rejected.
- Agent definitions select a specific discovered model independently of the provider default; existing
  agents retain the provider-default fallback and suspended turns retain their original model identity.
- Existing agents can be reopened and edited in Agents without losing their identity, conversation or any
  stored skill assignments; name, description, persona, provider, model, autonomy and memory access persist locally.
- Agent capability selection is grouped by source in a popup for built-in IRIS, Workspace, Memory,
  connected MCP tools and local/imported skills, with Select all/Clear all per group. Selection remains
  separate from tool authority and does not bypass permissions.
- Capability source groups now include an authority dropdown: Ask, Allow read, Allow read + write or Deny.
  Selecting a group authority also assigns the group; non-read risks remain Ask under Allow read.
- Agents can carry an optional user-authored persona/soul. It is persisted and injected as identity guidance
  into runtime context, explicitly without granting tool authority.
- `janitor` is available as an autonomy label, but it is only a role title and grants no machine or server
  access by itself.
- Janitor has a real `janitor.command` execution tool for the local PC and Unraid. It runs locally through
  the native Tauri boundary or through `/mnt/ai/handoff/unraid-ssh.sh`, caps command input/output and runs
  for at most 60 seconds, remains deny-by-default behind the existing approval and audit flow, and refuses
  every non-Janitor agent.
- Janitor subprocesses explicitly pipe stdout and stderr before `wait_with_output()`, so command and health
  results reach the desktop agent in both terminal-launched and packaged desktop runs; previously terminal
  launch only appeared to work because child output was inherited by the terminal.
- Janitor also has a fixed, read-only `janitor.health` tool for connectivity, system, storage, Docker,
  crash-loop and full checks against the local PC or Unraid. It accepts no arbitrary command text and uses
  the same native boundary, Janitor-only gate, approval and audit path.
- Existing Janitor agents receive the health capability on their next chat turn with an explicit persisted
  `Ask` rule, while non-Janitor agents remain unable to use it; the bounded per-turn tool-call budget is 16.
- Janitor command execution blocks destructive Docker operations against Hermes, Nginx Proxy Manager,
  Cloudflared, LiteLLM, PostgreSQL/MySQL and Docker socket targets, and blocks local network interface or
  route mutation commands. The persona's broader backup-before-change guidance remains visible policy.
- Janitor local command execution no longer inherits stdin from the process that launched IRIS. A `sudo`
  inside a local command used to block silently on that inherited stdin — invisible from the GUI, and only
  resolvable by typing the root password into whatever terminal had started IRIS. stdin is now always
  `Stdio::null()`. When a local command needs `sudo`, IRIS instead shows an in-app password popup, sends the
  password to the subprocess once through a `SUDO_ASKPASS` helper (env var only, never written to disk or
  logged), and the backend independently refuses to run a `sudo` local command without a password rather than
  trusting the frontend's own detection. Unraid targets are unaffected: that connection already authenticates
  as root over SSH, so no sudo password is ever needed there.
- Janitor has a dedicated `janitor.projectcockpit` tool for live `/api/` requests to ProjectCockpit at the
  documented local host. It supports bounded JSON GET/POST/PUT/PATCH/DELETE requests with no credential
  copying, native timeout/redirect limits and the same Janitor-only execution gate. Mutations now require a
  local preflight snapshot and explicit bounded plan: preview reads the live resource and records a diffable
  snapshot, apply refuses mismatched or stale resources before sending the mutation, and the result includes a
  real follow-up GET verification status. Applied preflights are single-use to prevent replaying an approved
  mutation. Snapshots are local metadata only and are not presented as a remote backup or rollback.
- The agent editor lists every real registered tool and persists assignments. Assignment remains separate
  from authority, so tools still require an explicit allow or ask policy before execution.
- Each assigned tool exposes its Ask, Allow or Deny policy directly in the agent editor. New assignments and
  existing assignments without a matching rule safely default to Ask, producing an inline approval instead
  of remaining silently unusable; System stays synchronized with the same explicit rules.
- Agent changes and tool assignments synchronize between the open Agents and System windows and refresh the
  runtime configuration before the next turn.
- Tool registry and deny-by-default permission engine with approval-required decisions.
- Graphical System permission workbench for per-agent tool assignment and explicit policy inspection.
- Local repositories for permission rules and a capped, newest-first permission audit stream.
- Audited permission evaluation distinguishes graphical inspection from execution checks.
- Persistent per-invocation approval requests with deny, approve, resume, completed and failed states.
- First real read-only tool adapter for native host inspection through the permission-gated executor.
- System workbench can inspect and run registered tools, resolve approvals and show real outcomes.
- OpenAI-compatible SSE and Ollama NDJSON adapters normalize structured tool calls and tool results.
- Agent sessions run a bounded provider/tool loop through a replaceable tool-runtime contract.
- The bounded tool loop now completes with a truthful visible assistant result at its safety limit,
  gives the provider one no-tools summarization pass, and preserves received tool results instead of
  surfacing an opaque fatal error in desktop chat.
- Agent-requested tools use the shared audited executor; ask decisions pause for explicit inline approval.
- Inline approvals show the requested path, overwrite intent and a bounded content preview before execution.
- Deny-by-default tool decisions return a structured denial to the model, allowing it to explain missing
  authority and complete the turn instead of surfacing the permission decision as a fatal chat error.
- Suspended agent turns persist their provider, model, model message history and remaining tool calls locally.
- A framework-independent runtime coordinator owns conversation persistence, suspension and restart-safe resume.
- The shared System approval queue resumes linked agent turns and saves the model's continued response.
- Restored desktop windows are normalized into the interactive layer and stay above the canvas.
- Framework-independent memory records, repository contract and deny-by-default access service.
- Persistent local memory records with manual-user provenance and timestamps.
- Explicit per-agent memory read access that can be changed from the Memory window.
- Granted agents receive a bounded saved-memory snapshot through the runtime context boundary.
- Truthful Memory window for saving, inspecting and forgetting real records and their provenance.
- Agent-authored memory is a real write-risk tool with separate assignment and permission policy.
- Agent memory records persist the originating agent, runtime turn and provider tool call.
- Memory tool approvals retain their invocation provenance across restart-safe resume.
- The Memory window refreshes from local persistence and exposes agent provenance for review or deletion.
- Replaceable memory-retrieval contract with a deterministic local lexical implementation.
- Explicitly granted agents receive bounded memories relevant to each current prompt instead of newest-first snapshots.
- Query-specific memory context stays outside visible conversation history and survives restart-safe tool approvals.
- Optional embedding retriever ranks memory by cosine similarity behind the same domain contract.
- Real Ollama `/api/embed` batch adapter uses an explicitly selected local provider and embedding model.
- Retrieval configuration persists locally, remains lexical by default and exposes a real embedding connection test.
- The Memory window reports lexical, configured and unavailable embedding states without simulating connectivity.
- Model-scoped embedding indexes persist locally with their source-record fingerprints and build timestamp.
- Memory mutations and embedding provider or model changes invalidate persisted vectors.
- Index rebuilds retain unchanged validated vectors and checkpoint after every completed record.
- Interrupted and failed rebuilds persist per-record progress, errors and attempt counts for explicit retry.
- Switching to lexical retrieval leaves model-scoped checkpoints intact and independently usable later.
- The Memory window exposes real ready, pending, active and failed record states with truthful progress and retry.
- Semantic recall embeds only the current prompt against a validated index and refuses stale or malformed vectors.
- Framework-independent Cortex context packs own per-turn memory selection and source status.
- Each context pack contains real record snapshots, provenance and retrieval rank.
- Agent runtime derives hidden model context from the pack while visible conversation history stays unchanged.
- The agent window can inspect selected records, why they were selected and honest no-match or no-access states.
- Runtime turns now use one durable ID across visible user and assistant messages, Cortex context packs,
  tool invocations and restart-safe approval resume.
- Context packs persist newest-first in a bounded 40-turn history per agent; previous latest-only packs
  migrate as explicitly unlinked legacy context.
- Each linked assistant answer can open the exact context pack that produced its turn, and the agent
  window can browse earlier packs without adding hidden context to conversation history.
- Framework-independent Cortex turn records persist provider/model identity and running, suspended,
  completed or failed lifecycle state against the same durable runtime turn ID.
- Approval suspension and restart-safe resume update the original Cortex turn instead of creating a
  disconnected audit record; real failure messages are retained.
- Interrupted running records reconcile to failed after restart, while a matching persisted approval
  reconciles to suspended instead of claiming active execution.
- The context inspector shows the selected turn's real provider, model, timestamps and outcome; older
  context packs remain inspectable with an explicit unrecorded lifecycle state.
- Framework-independent Cortex turn steps persist one durable record per tool call — name, input, status,
  timestamps and, once resolved, its real output or denial/failure reason — surviving approval suspension
  and restart instead of only living in the ephemeral event stream.
- The context inspector's timeline lists a turn's real tool calls in order with status, wall-clock duration
  and expandable request/result detail, plus the turn's real input/output token cost once completed.
- Framework-independent project task graphs persist real user-authored objectives, tasks and prerequisites.
- Task readiness is derived from completed prerequisites; blocked tasks cannot be completed and completed
  prerequisites cannot be reopened beneath completed dependents.
- Framework-independent project workflow runtime requires explicit launch, a ready task and a real configured
  agent before creating a worker run.
- Project worker runs persist queued, running, suspended, completed and failed lifecycle state plus their agent,
  runtime turn, approval, output or concrete failure.
- Temporary project workers reuse the selected agent's provider/model, Cortex memory context and shared
  permission-gated tool runtime while keeping worker conversations, suspensions and Cortex records isolated
  from the agent's normal conversation.
- Worker tool approvals enter the shared System approval queue and resume the originating project run across
  restarts; interrupted runs reconcile from their persisted worker Cortex state.
- Only a successfully completed worker run completes its originating graph task and unblocks dependents.
- The Projects desktop object selects a worker agent, explicitly launches ready tasks and displays honest latest
  run state and outcome; manual completion remains available only while no worker is active.
- Project workers can be cancelled through a durable cancelled terminal state; active model/provider streams receive
  an AbortSignal, suspended approvals are removed through the agent runtime boundary, and cancellation never
  completes the originating task.
- Projects now expose a persisted run-history inspector with newest-first runs, task/agent identity, lifecycle
  timestamps, runtime turn, approval context, outcome and failure/cancellation details.
- Framework-independent schedule definitions and scheduled-run records support validated one-time, daily and
  weekly timing with explicit time zones and deterministic next-run calculation.
- Schedules and run history persist locally with enable/disable and delete operations; a graphical Schedules
  object exposes real local state behind a separate runner boundary.
- The Schedules editor updates existing schedules without changing their identity, supports multiple weekly
  weekdays, preserves paused state, and recalculates the next occurrence. Run history is expandable per run
  and exposes persisted prompt, lifecycle timestamps, retry, approval, output and failure details without
  fabricating runtime data.
- One-time schedule datetime inputs are interpreted in the selected IANA timezone rather than the browser's
  local timezone; the editor exposes the runtime's supported timezone list and rejects nonexistent DST wall-clock
  times instead of silently shifting them.
- Schedule next-run and scheduled-for displays use the configured IANA timezone, so the visible clock matches the
  schedule semantics instead of the browser timezone.
- A durable local ScheduleDispatcher detects due schedules, creates idempotent scheduled runs, advances the
  next occurrence, records queued/running/completed/failed lifecycle states, and reconciles interrupted runs
  to failed after restart. Desktop scheduling uses the existing AgentRuntimeCoordinator, so provider errors
  and permission approvals remain real rather than simulated. Schedules can opt into persisted retries with
  bounded attempt counts and restart-safe retry times; the Schedules window shows attempt status and resolves
  scheduled-run approvals through the shared permission queue. Dispatcher lifecycle changes now notify the
  open Schedules window immediately, including interval-driven retries and completion/failure transitions.
  Overlapping interval ticks and duplicate approval resumes are guarded in-flight per persisted run, so one
  scheduled execution cannot be started twice concurrently.
- A fourth schedule recurrence, 'idle' ("Dreaming"), fires after a configured number of minutes with no real
  user activity (sending a chat message) instead of a calendar time. Real activity keeps pushing the due time
  forward; firing goes back to quiet until the next idle spell, rather than recomputing a calendar next-run.
  It reuses the exact same ScheduleDispatcher/AgentRuntimeCoordinator path as every other schedule — a
  Dreaming run is a normal, visible agent turn (default prompt asks the agent to review the day and save
  anything worth keeping via memory.remember), not a hidden background process.
- Framework-independent workspace contracts keep mount persistence and list, search and read operations
  replaceable and free of React or Tauri dependencies.
- The native desktop can select and persist one real local folder, restores it across sessions and keeps the
  canonical root in native state for every file operation.
- Native workspace paths reject absolute input, parent traversal and symlink escapes; directory listings,
  UTF-8 reads and recursive text/path search are bounded and return only workspace-relative paths to agents.
- The Workspace desktop object shows the actual mounted path, navigable files, bounded text previews and real
  search results; browser preview reports that native access is unavailable instead of simulating contents.
- Separate workspace list, search and read tools are registered as read risks and remain deny-by-default until
  assigned and explicitly allowed per agent in System.
- Native directory creation and bounded UTF-8 whole-file writes stay inside the canonical root, reject traversal
  and symlink targets, require existing parent directories, refuse implicit overwrite and replace existing files
  atomically only when overwrite intent is explicit.
- Separate workspace create-directory and write-file tools are registered as write risks, retain agent/turn input
  in the approval queue and refresh an open Workspace object after successful execution.
- Workspace move/rename is available as a separate permission-gated write tool. It shows source and target in
  the approval preview, refuses overwrite, traversal, symlink sources/targets and directory self-moves, uses
  native atomic rename inside the mounted root, and refreshes the Workspace object after success.
- Workspace delete is available as a separate permission-gated write tool. It shows the exact relative target
  in the approval preview, rejects traversal, symlinks and deletion of the mounted root, removes files or
  directories only inside the canonical root, and refreshes the Workspace object after success.
- Agent and temporary worker turns receive the real mounted root and their exact assigned workspace tool IDs,
  distinguishing no mount, unavailable native state and a mounted workspace without assigned file tools.
- Framework-independent skill definitions with validated names, bounded summaries and bounded instructions,
  persisted locally as versioned records that reject malformed stored values.
- The Skills object creates, edits, enables, disables and deletes real skills and reports which agents use them.
- The agent editor assigns real skills beside tools; assignment stays separate from enablement, and stored
  assignments pointing at deleted skills are reported and dropped explicitly rather than silently kept.
- Cortex context packs own skill selection alongside memory selection, so one per-turn boundary decides all
  hidden model context.
- Only assigned and enabled skill instructions are injected; disabled, unassigned and deleted assignments
  produce honest source states instead of silent omissions.
- Skill instructions are framed as user-authored operating guidance and explicitly grant no tool authority,
  while memory stays framed as data with provenance.
- The context inspector shows each injected skill, its name, its last edit and why it was selected, and skill
  context survives restart-safe approval resume like memory context.
- A replaceable skill-catalog contract browses a real public directory. The Skills Playground implementation
  paginates, searches and filters against its documented v1 REST API and resolves each instruction body from
  the bulk endpoint that actually carries it, then follows the linked GitHub source when the directory only
  repeats the entry description.
- Catalog payloads are treated as untrusted input: every field is validated, unreadable rows are dropped
  instead of partially trusted, and a failing catalog reports unavailable rather than showing a stale list.
- Because the catalog and source documents cannot be read from the webview, requests run through a native Rust
  command with a fixed HTTPS allowlist. GitHub access is limited to public Markdown documents, rejects
  credentials and queries, follows no redirects and remains unavailable in browser preview.
- Importing shows the exact instruction text first, records the catalog, slug and source URL as skill origin,
  refuses a second import of the same entry and never truncates instructions to fit the injection bound.
- Most directory entries carry no instructions at all: 8,766 of 8,883 repeat their own description in the
  instruction field. IRIS detects that exactly and reads the linked repository's `SKILL.md` instead. If neither
  source carries a real body, the preview states that honestly and refuses the import.
- Imported and locally written skills are the same kind of record afterwards, so assignment, enablement,
  injection and provenance behave identically and the Skills window states which is which.
- Imported skills retain a source fingerprint and repository/document provenance; the Skills window can re-check the exact source, report unchanged, changed, moved or unavailable states, show a bounded instruction diff and require explicit acceptance before replacing local instructions. Older imports fall back to their stored text and GitHub source when these fields are absent.
- Skill source-review UI state is bound to the reviewed skill and is cleared on selection changes, so an asynchronous or previous diff cannot appear attached to another imported skill.
- A framework-independent MCP client implements JSON-RPC 2.0, the `initialize` handshake with protocol
  version negotiation, the initialized acknowledgement, `tools/list` and `tools/call` behind a replaceable
  transport, reading both plain JSON and SSE reply bodies.
- The native transport reaches a user-supplied address over HTTPS, or HTTP only on loopback, refuses
  credentials in the URL, follows bounded same-origin canonical redirects and never forwards a bearer token
  across an origin boundary.
- Connections persist as non-secret local metadata while bearer tokens live in the OS keyring; adding a server
  connects first, so a stored connection always means the handshake really succeeded.
- Discovered MCP tools are registered as external risks that stay deny-by-default: they need the same explicit
  per-agent assignment and Ask, Allow or Deny decision as native tools, and pause for the same inline approval.
- MCP prompts are discovered through the real `prompts/list` endpoint and can be inspected through
  `prompts/get`; prompt content remains read-only server content and is never registered as tool authority.
- MCP resources are discovered through the real `resources/list` endpoint and read through `resources/read`;
  Connections exposes bounded text inspection and explicit non-rendered binary states. Resources remain
  read-only server content and are never registered as tool authority.
- MCP resource templates are discovered through the optional `resources/templates/list` endpoint, with
  bounded descriptor validation and an honest empty state for servers that do not expose the method.
  Connections shows URI templates as read-only metadata; IRIS never expands them automatically, fetches
  them implicitly or treats them as agent/tool authority.
- Tools are re-read from the server on every connect and dropped when it cannot be reached, so an unreachable
  server never leaves a phantom tool an agent could call.
- Local skills can author bounded bundled material through a validated JSON manifest containing relative
  files and descriptive `skill.*` capability declarations. Bundles persist with the skill, expose their
  files and provenance in Skills, and never grant runtime authority; only host-provided capabilities are
  registered, and assignment plus explicit permission remain required.
- Connections browses the official MCP registry, which unlike the browsable directory publishes each remote
  server's real endpoint, so choosing one fills the address in instead of leaving the user to find it.
- Each registry entry states whether IRIS can reach it: a published HTTP endpoint is connectable, a
  local-package server is marked not connectable, and an entry with no endpoint says so.
- Connecting probes first. A server that answers an OAuth challenge is offered a sign-in rather than reported
  as a failure, and one that simply rejects a token still says the credentials were wrong.
- Interactive sign-in follows the MCP authorization chain and recovers through RFC 9728 endpoint-specific
  and root well-known metadata when a challenge is absent or stale; challenged scopes take precedence.
- Authorization metadata must match the discovered issuer and explicitly advertise PKCE S256 before IRIS
  opens a browser; unrelated loopback requests cannot consume the pending OAuth callback.
- IRIS registers itself dynamically as a public client, runs the authorization-code flow with PKCE against a
  loopback redirect on an OS-assigned port, and verifies the returned state before using the code.
- Access and refresh tokens plus an optional dynamically issued client secret live in the OS keyring; only
  the non-secret client id, endpoints and scopes are local metadata. Expiring tokens refresh a minute early.
- Native OAuth requests follow no redirects, so a refresh token cannot be forwarded to another host.
- A revoked refresh token, missing stored sign-in or later MCP 401 becomes a recoverable sign-in-required state;
  Connections offers a fresh browser sign-in and verifies the replacement token before saving it.
- Tool failures, including MCP rate limits, revoked scopes and expired authorization, are returned to the model
  as real tool outcomes after both direct and approved calls, so the agent can explain them and complete its
  turn instead of losing the conversation.
- The framework-independent MCP bridge now recognizes server-initiated JSON-RPC requests carried alongside
  normal JSON or SSE responses. Requests receive immutable connection/method/id provenance, use an explicit
  handler boundary that denies by default, return JSON-RPC errors or results over the same session, and are
  bounded by a 30-second timeout plus AbortSignal cancellation.
- MCP server-request handling now has a persisted, connection-scoped policy surface in Connections. The
  supported `roots/list` request is denied unless explicitly allowed; when allowed it returns only the real
  mounted workspace root (or an empty roots list when no workspace is mounted). Unsupported methods remain
  denied, and policy changes do not grant agent tool authority.
- MCP `elicitation/create` now has an explicit per-connection policy and a real interactive form flow for
  bounded primitive schemas. Pending requests appear in Connections and return accept, decline or cancel
  results over the originating MCP session; URL mode, unsupported schemas and unavailable UI remain honest.
- MCP `sampling/createMessage` now has an explicit per-connection allow/deny policy and an explicit local
  provider/model selection. Bounded text-only requests use the existing provider adapters and AbortSignal,
  never receive tool definitions, and return real model output or an honest JSON-RPC error.
- Provider model requests accept bounded sampling generation options (temperature, max tokens and stop
  sequences) across the existing native adapters without changing the agent tool loop.
- MCP completion requests now use the active connection session for prompt argument suggestions. Returned
  values are bounded and validated, and Connections exposes a real completion action with honest server errors.

- Bundled skills now have a framework-independent persisted model for bounded relative files and
  namespaced declarative tool capabilities. Bundle declarations contain no callable handlers and never
  grant tool authority; `SkillService.setBundle` keeps this material separate from injected instructions.
- Bundled skill persistence now enforces a data-only boundary: runtime-shaped `run`/`handler` fields and
  non-JSON schema values are rejected, while persisted bundles are cloned from an allowlisted snapshot so
  unknown runtime extras cannot cross into local state. Declaration schemas are now restricted to acyclic
  JSON-compatible plain data, with boundary tests for cycles and non-JSON objects.
- Bundled skill records can retain validated source URL, fingerprint and review status; the Skills window
  exposes that provenance and distinguishes an unchecked, changed, moved or unavailable source without
  activating declared capabilities.
- The Skills window now exposes bundled files, bounded content previews, declared capability metadata and
  local/imported bundle provenance for review. It states explicitly that declarations are not registered,
  do not grant authority and cannot execute.
- Bundled capability declarations now pass through an explicit framework-independent registration boundary:
  IRIS can produce an immutable, data-only registration plan with a typed unavailable state, but cannot
  produce a runtime tool until a separate provider and permission registration is supplied.
- Registration plans are now deep-readonly and runtime-frozen, including nested declaration schemas, so
  host inspection cannot mutate the persisted bundle or accidentally turn the plan into tool authority.
- Bundled capability declarations now have an explicit desktop runtime-provider bridge. A host-supplied
  provider must match a persisted declaration before it is registered as a normal tool; registration never
  assigns it to agents or creates permission rules, so the existing deny-by-default approval/audit path
  remains mandatory. Provider handlers are runtime-only and disappear on restart, leaving unavailable
  capabilities honest until a provider is registered again.
- The first concrete bundled provider is the reserved `skill.bundle.read_file` read capability. It returns
  only an exact file from that skill's persisted bundle, never reaches the host filesystem, and is synced at
  runtime without persisting a handler. Assignment and permission remain explicit; unknown or traversal-like
  paths fail honestly.
- A second bundled provider, `skill.bundle.list_files`, returns only persisted bundle paths and UTF-8 byte
  sizes. It never returns file contents or reaches the host filesystem, and it remains separately assigned and
  permission-gated like the bundled file reader.
- A third bundled provider, `skill.bundle.search_files`, searches bounded text only in persisted bundle files,
  returns capped line matches, rejects malformed or traversal-like paths, and remains separately assigned and
  permission-gated like the other bundled read capabilities.
- The bundled `skill.bundle.summary` provider reports only persisted skill metadata and bundle file counts/bytes;
  it accepts no payload and remains separately assigned and permission-gated.
- The bundled `skill.bundle.find_files` provider finds bounded, case-insensitive path matches and UTF-8 byte
  sizes only in persisted bundle files; it never reaches the host filesystem and remains separately assigned
  and permission-gated.
- The bundled `skill.bundle.read_csv` provider parses bounded CSV files from persisted bundle data, including
  quoted fields and custom one-character delimiters; malformed input and oversized rows, fields or results
  fail honestly, and assignment plus explicit permission remain required.
- Bundled capability synchronization removes stale built-in registrations when a declaration is removed or
  changes risk, while preserving other active providers for the same skill; registry cleanup is covered by a
  regression test.

## Intentionally not implemented yet

- General command execution is now available only through the Janitor-only `janitor.command` tool; workspace
  patch/diff changes remain separately permission-gated with bounded previews and stale-safe native apply.
- Bundled skill files and tools are modeled and reviewable in Skills. The reserved read-only providers for
  reading, listing, searching, summarizing and parsing bundled JSON are concrete; other declared capabilities
  remain unavailable until an explicit provider exists, and assignment and permission remain explicit.
- Local stdio MCP servers now use an explicit persisted command/arguments configuration, run only through
  the native desktop boundary with a cleared environment and bounded protocol payloads, and retain the
  existing deny-by-default assignment and permission model for discovered tools.
- OAuth authorization servers without dynamic client registration can use a user-supplied public client id;
  client registration remains dynamic by default and no client secret is inferred or stored from that field.
- Other external integrations.

The UI displays honest empty states for these areas instead of fake data.

## Current product slice

A user can browse 8,883 real skills from Skills Playground inside IRIS, search and filter them, and review the
exact instruction body before importing. When the catalog has no body, IRIS reads the linked repository's
`SKILL.md` and records that exact document as provenance. An imported skill is then an ordinary IRIS skill:
assign it to an agent and its instructions shape the next turn without granting tool authority.

The directory is reported as it really is rather than as it advertises itself: description-only catalog rows
are not treated as instructions, and an entry with no readable source document is refused instead of storing a
capability claim it cannot back.

A user can also find a real MCP server in the official registry, connect to it at the address the registry
publishes, sign in when the server requires it, and see the tools it actually advertises. Those tools are
assigned to an agent under the same deny-by-default authority as every native tool: an MCP call pauses for the
same inline approval, runs against the real server, and returns its real result to the conversation.
A server can additionally request bounded text sampling only when the user has allowed it for that connection
and selected the provider/model that may answer it.
Prompt argument suggestions can also be requested from the connected server through the read-only completion
endpoint; values remain bounded server content and do not create tool authority.
If authorization expires, Connections can sign in again; if a call itself fails, that outcome is returned to
the model so the turn can explain what happened.

## Next product slice

Continue release hardening around migrations and unavailable-state recovery. Bundled skill declarations without
an explicit provider remain unavailable. A further Janitor backup/rollback slice remains blocked on a concrete
ProjectCockpit backup contract; the current API tool provides local preflight, approval gating and live
verification without pretending that a local snapshot is a remote backup.
