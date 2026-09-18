# IRIS · Intelligent Reasoning & Integration System

<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" height="96" alt="IRIS Logo" />
  <h3>A local-first desktop environment for AI agents that do durable work</h3>
  <p>Agents, projects, tools, browser sessions, memory, documents and schedules — as real objects on a spatial desktop, under permissions you can see.</p>

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
[![Verify](https://github.com/bubbadk/IRIS/actions/workflows/verify.yml/badge.svg)](https://github.com/bubbadk/IRIS/actions/workflows/verify.yml)
[![FP-AMB Memory Benchmark](<https://img.shields.io/badge/FP--AMB%20(measured)-70.1%25%20(155%2F221%20gradeable)-success.svg?style=flat-square>)](#memory-benchmark-measured)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20verified%20%7C%20macOS%20%26%20Windows%20build%20targets-amber.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
[![Build](https://img.shields.io/badge/Build-Tauri%202%20%7C%20Native%20AppImage-purple.svg?style=flat-square)](https://github.com/bubbadk/IRIS)
</div>

<br />

<div align="center">
  <img src="docs/screenshots/iris-desktop-main.png" alt="The IRIS spatial desktop with agent and project windows open" width="100%" />
</div>

---

## What IRIS is

**IRIS** is an installable desktop application, not an SDK, a hosted service or a chat window with a sidebar attached. It gives AI agents a place to actually work: agents, projects, tools, browser sessions, memory, documents and schedules are first-class objects on a spatial desktop that you can open, arrange, inspect and run side by side.

Agents in IRIS do durable work rather than single replies. A project holds an ordered task queue with dependencies and acceptance criteria. A schedule keeps recurring work running under exclusive ownership. Every execution-capable tool call passes through an explicit permission policy, and anything you mark as requiring approval stops and waits for you before it happens. Interrupted work is reported rather than silently repeated.

IRIS is **local-first**. Conversations, memory, project state, documents and knowledge live in a local SQLite store; provider credentials are written to the operating system keyring. The model layer is a provider contract, so you can run agents against a local Ollama model or point them at a hosted provider — OpenRouter, OpenAI, Anthropic or Gemini.

IRIS does not fabricate activity to look busy. If a provider is unreachable, a tool is unconfigured or a capability is missing, the interface says so. Empty state is preferred over simulated state.

## New in 0.3.2

v0.3.2 is a small correctness release. Nothing else changed.

- **CSV export round-trips.** A valid document whose last record is blank is exported and re-imported with its record structure intact, instead of being refused as "incomplete".
- **The Documents window stops showing an error it has already disproved.** After a successful reload, the stale "could not be read" message is cleared — while a refused save or export you have not read yet is still shown.
- **Dropped channel updates are visible.** Channel updates IRIS could not apply are listed in the Channels window and stay listed until they are resolved.

The 0.3.x line as a whole introduced durable projects and schedules, cross-process execution ownership, documents and human-approved durable knowledge, a visible browser session, and native test coverage that builds and passes on Linux, macOS and Windows. See the [0.3.2 release notes](dist-release/RELEASE_NOTES_v0.3.2.md) for the full implemented / limited / not-verified breakdown.

## What IRIS can do

### Agents

- **Configurable agents.** Each agent has its own provider and model, autonomy level, system instructions, memory access, tool set, skills and channels. Setup creates a default team (a coordinator and a senior developer) plus a system janitor, and you can define your own agents from scratch.
- **Provider and model choice.** OpenRouter, OpenAI, Anthropic, Gemini and local Ollama models sit behind one provider contract. The Models window tests connectivity for real instead of assuming it works.
- **Explicit tool permissions.** Tools are granted per agent and split by capability — reading a mounted folder, writing to it and executing a command are three separate decisions.
- **Approval gates.** Execution-capable tools can require `Apply` / `Deny` confirmation on every call. Mandatory approvals cannot be bypassed by autonomy settings, allow rules, delegation, schedules, channels or resumed runs.
- **Delegation.** An agent can hand a bounded subtask to a child agent, which inherits strictly narrower authority than its parent.
- **Durable execution state.** Streaming responses and pending approvals survive moving between views, and a model handoff keeps one truthful attributed transcript.
- **MCP support.** A Model Context Protocol client with Stdio, SSE and HTTP transports connects external tool servers.

### Projects

- **Multi-step work with structure.** Break a goal into tasks with declared dependencies, instructions and acceptance criteria.
- **A durable task queue.** Task transitions are atomic, so a task has one owner even across restarts.
- **Bounded execution.** Runs have a bounded number of turns, an optional wall-clock deadline and saved tool-result checkpoints, and can be paused and resumed by hand.
- **Human acceptance.** A task with criteria completes only after a saved human assessment with rationale and evidence. Completion re-reads every configured target and refuses changed, deleted or empty evidence.
- **Bounded repair.** A failed configured check can produce a bounded repair proposal instead of unlimited retries, and open blocking findings survive later runs until a human resolves them.

### Scheduling

- **Cron-style schedules.** Recurring work is dispatched from a durable queue with exclusive ownership.
- **Interruption is treated as unknown, not as success.** A run that stopped with an undetermined external outcome is reported for inspection and is never replayed automatically.
- **Background runtime where supported.** On Linux, an optional per-user systemd service keeps dispatching the schedule and project queues after the main window closes.

### Browser & web

- **A visible browser session.** Agents drive a real Chrome/Chromium session you can watch, with navigation, element snapshots, clicks, typing and captured screenshots.
- **You can take over.** Take control of the session at any time; operations referencing a stale target are refused rather than guessed at.
- **Web search and extraction.** `web.search` and `web.extract` are available through an optional Firecrawl integration.
- **Native public-web reads.** Agents can read public pages through a native reader with no browser dependency.
- **Enforced network boundaries.** An enforcing proxy permits public HTTPS and blocks loopback and private-network destinations, including across redirects.

### Knowledge & memory

- **Durable memories.** Ordinary memories are retrieved with lexical and embedding search and hybrid ranking.
- **Approved project knowledge.** Global and project facts and preferences require human approval, carry provenance and source attribution, keep immutable revisions, support optional expiry, and replace conflicting entries atomically.
- **Project precedence.** Project knowledge takes precedence over global knowledge in a project's context.
- **Inspectable retrieval.** The Memory window shows what was stored and why it was retrieved, including the Memory Constellation view of what an agent actually remembers.
- **A benchmark you can run.** The FP-AMB evaluation runner ships in the app; see [Memory benchmark](#memory-benchmark-measured).

### Documents

- **Durable revisions.** Create, read, list and revise Markdown, text, HTML, SVG, JSON and CSV documents. Every revision is attributed to an author and a turn and written with a revision check.
- **Safe previews.** HTML and SVG previews render in a sandboxed frame with scripts and same-origin access removed.
- **Export.** Export to the original format or to real DOCX, PDF, XLSX and PPTX. Office exports are generated natively and are deliberately simple — plain-text PDF layout, basic comma-separated rows and plain-text slides — not a replacement for a full office suite.
- **Agent document tools.** Agents can create, read, list and revise documents under the same permission policy as every other tool.

### Workspace

- **Mount a real folder.** A local directory becomes an IRIS object; agents do not inherit access merely because it is mounted.
- **File operations.** List, search, read, write, patch, create directories, move and delete, with native path enforcement inside the selected root.
- **Sandboxed shell.** `shell.exec` defaults to offline Bubblewrap isolation on Linux, with no silent fallback to the host.
- **Restore points.** Content-checked restore points cover native text writes and patches, so a guarded restore refuses to overwrite a file that changed underneath it.

### Channels

- **Telegram (inbox and approvals).** Optional polling from an allowlisted chat delivers approval requests and routes your approve/deny decision back to the exact pending agent, project or schedule request.
- **Discord (outgoing only).** Discord is an outgoing webhook sender for notifications. It has no inbound listener and is not equivalent to the Telegram integration.
- **Visible failure.** Channel updates IRIS could not apply are recorded and listed in the Channels window.

### Desktop shell & updates

- **A spatial desktop.** Windows can be moved, resized, clamped to the viewport and arranged into saved named layouts, with keyboard move and resize. A floating glass desklet and a system tray keep IRIS reachable.
- **Shared sessions.** Chat sessions and pending approvals stay alive when you switch views.
- **In-app updater.** The updater shows readable release notes for the exact target version and refuses missing summaries, changed targets and unsigned metadata.

## What you can use IRIS for

- **Run a research project as durable work.** Give an agent a goal with acceptance criteria, let it work in bounded runs, then review the evidence and accept or reject the result.
- **Keep a knowledge base across sessions.** Approve facts, decisions and preferences as global or project knowledge so later sessions start from what you already established.
- **Schedule recurring work.** Put a recurring report, check or collection task on a schedule that keeps one owner and survives restarts.
- **Research the public web with a browser you can watch.** Point the session at a page, let the agent navigate and extract, and take control whenever you want.
- **Work inside a local code or document folder.** Mount the folder, grant only the file and shell capabilities the agent needs, and review every write.
- **Produce and export deliverables.** Draft a document with an agent, preview it, then export it as DOCX, PDF, XLSX or PPTX.
- **Coordinate several agents with explicit permissions.** Run specialist agents side by side, with delegation that can only narrow authority.
- **Escalate only when it is worth it.** Start on a fast, inexpensive model and hand off to a frontier model on the same conversation when the work needs it.
- **Recover instead of guessing.** After a crash or restart, see what was interrupted and what evidence is missing before anything runs again.

## Built for useful agents without invisible authority

Autonomy is only useful when you can see what it is doing and stop it. IRIS is built around that idea:

- **Permissions are explicit.** A capability exists because you granted it, to that agent, for that tool. Mounting a workspace grants nothing by itself.
- **Approval gates are enforced at the execution path.** Mandatory approvals are checked where the action is authorized, not in the button that raised them, so no autonomy setting or alternate route can slip past them.
- **Durable state makes work inspectable.** Projects, runs, tool results, documents, knowledge revisions and approvals are persisted, so you can open a record and read what actually happened.
- **Execution ownership prevents accidental duplicate work.** A queue claim is written before any side effect, and ownership is bound to a real operating-system process identity.
- **Interrupted side effects are handled conservatively.** When the outcome of a stopped run cannot be determined, IRIS reports it for inspection rather than replaying it.
- **Workspace and web boundaries are deliberately narrow.** Native paths are enforced inside the mounted root, shell execution defaults to offline isolation, and network access is restricted to public HTTPS destinations.
- **Important results still need a human.** Project completion requires a saved human assessment and re-reads every configured target before committing.

This is trust through clarity, not a claim of perfect security.

## A look inside

<div align="center">
  <img src="docs/screenshots/iris-agent-workspace-v020.png" width="49%" alt="An agent workspace showing its tools, permissions and model routing" />
  <img src="docs/screenshots/iris-project-graphs-v020.png" width="49%" alt="A project task graph with declared step dependencies" />
  <br />
  <sub>An agent workspace with its tools and permissions · A project task graph with declared dependencies</sub>
  <br /><br />
  <img src="docs/screenshots/iris-capsule-desklet-v020.png" width="58%" alt="The floating glass desklet on the desktop" />
  <br />
  <sub>The floating glass desklet keeps IRIS reachable when the main window is closed.</sub>
</div>

## Memory benchmark (measured)

IRIS ships the benchmark runner, the corpus and the grader, so the number below can be reproduced rather than taken on faith.

- **Run it yourself:** Memory → FP-AMB Benchmark (Live Verification), or `node scripts/benchmark-memory.mjs`.
- **Measured report:** [docs/verification/retrieval-baseline.json](docs/verification/retrieval-baseline.json) records the commit, working-tree state and source hashes.
- **What it measures:** whether the accepted answer is present in the retrieved records, not whether an agent writes the correct final answer. The grading is word-boundary based.

**Measured retrieval coverage: 70.1%** (155 of the 221 automatically gradeable questions) on the 262-question [FP-AMB suite](https://github.com/munch2u-a11y/FP-AMB), over a 60-session, 739-turn corpus of 819,273 indexed tokens. Measured retrieval latency is 1.83 ms per query on local CPU; latency varies by machine and run.

| Category                                     | Retrieval coverage |    Result     |
| :------------------------------------------- | :----------------: | :-----------: |
| Source Credibility & Conflict Resolution     |     **100.0%**     |     5 / 5     |
| Speaker Attribution Traps                    |     **92.9%**      |    13 / 14    |
| Self-Referential & Procedural Tool Memory    |     **80.6%**      |    25 / 31    |
| Adversarial Defense & Gaslighting Robustness |     **76.9%**      |    30 / 39    |
| Single-Hop Fact Recall                       |     **74.3%**      |    26 / 35    |
| Adaptability & Fact Correction Overwrites    |     **72.2%**      |    13 / 18    |
| Cross-Session Multi-Hop Reasoning            |     **61.4%**      |    27 / 44    |
| Temporal Reasoning & Session Math            |     **45.7%**      |    16 / 35    |
| Unanswerable & Absent Memory Refusal         |        N/A         |  35 excluded  |
| **TOTAL (gradeable)**                        |     **70.1%**      | **155 / 221** |

41 of the 262 questions are excluded because they require semantic or LLM grading — auto-passing them would inflate the score. IRIS publishes the number it can actually measure and shows the misses rather than rounding them away.

## Architecture

IRIS is a pnpm monorepo. Domain logic lives in pure TypeScript packages that never import React or Tauri; the desktop application and the native Rust layer own all I/O, storage and platform access.

The request path is roughly: desktop UI → agent runtime (`@iris/cortex`) → provider contract (`@iris/providers`) → tool (`@iris/tools`) behind a permission policy → workspace, browser or native adapter → durable state in the native SQLite store.

| Package / App                                | Description                                                                                |
| :------------------------------------------- | :----------------------------------------------------------------------------------------- |
| [`apps/desktop`](apps/desktop)               | Tauri 2 native shell, React 19 spatial UI, floating desklet HUD, system tray               |
| [`packages/core`](packages/core)             | Core domain types, agent models, autonomy rules and validation                             |
| [`packages/agents`](packages/agents)         | Multi-agent execution engine, state machines and conversation repositories                 |
| [`packages/cortex`](packages/cortex)         | Reasoning loop, subagent delegation and autonomous turn execution                          |
| [`packages/providers`](packages/providers)   | Unified LLM provider contracts (OpenRouter, OpenAI, Anthropic, Gemini, Ollama)             |
| [`packages/tools`](packages/tools)           | Tool execution engine, audit trails and permission policy enforcement                      |
| [`packages/workflows`](packages/workflows)   | DAG task graphs, cron scheduler and durable project and schedule queues                    |
| [`packages/workspaces`](packages/workspaces) | Safe local directory mounting, patch generation, visual diffs and documents                |
| [`packages/memory`](packages/memory)         | Hybrid memory retrieval (lexical + embeddings), durable knowledge and the benchmark engine |
| [`packages/skills`](packages/skills)         | Sandboxed skill execution and capability scanning                                          |
| [`packages/mcp`](packages/mcp)               | Model Context Protocol client supporting Stdio, SSE and HTTP transports                    |
| [`packages/github`](packages/github)         | GitHub domain service, SemVer bumping, release scaffolding and CI/CD pipelines             |
| [`packages/subtitles`](packages/subtitles)   | SRT/VTT parser, sliding chunker, dialogue translator and reassembler                       |

## Getting started

### Download a release

Prebuilt Linux binaries are attached to [published GitHub releases](https://github.com/bubbadk/IRIS/releases) when a release exists:

- `iris-linux-x86_64-vX.Y.Z.tar.gz` — standalone binary bundle
- `IRIS_<version>_amd64.AppImage` — AppImage bundle

Source tags and downloadable releases are separate: a tag can exist without a published asset. Check the Releases page before relying on a binary. In-app updates require a package signed with the matching production key, and IRIS refuses unsigned metadata.

### Build from source

**Prerequisites**

- [Node.js](https://nodejs.org/) v22+
- [pnpm](https://pnpm.io/) v10+
- [Rust](https://rustup.rs/) (latest stable toolchain)
- Platform build dependencies for Tauri 2 (WebKitGTK, GTK and related development packages)

```bash
git clone https://github.com/bubbadk/IRIS.git
cd IRIS
pnpm install
pnpm desktop        # launch the desktop app in development mode
```

On **CachyOS / Arch Linux**, [`scripts/setup-cachyos.sh`](scripts/setup-cachyos.sh) installs the system packages, rustup and pnpm for you. On Debian/Ubuntu, install `libwebkit2gtk-4.1-dev libgtk-3-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, plus `squashfs-tools` if you want to build an AppImage.

Some capabilities need extra runtime prerequisites: Chrome with a compatible ChromeDriver for the visible browser, Bubblewrap with unprivileged user namespaces for sandboxed shell execution, and a reachable OS credential store for native credential storage and updater signature checks.

### Verify your checkout

The same commands the Verify workflow runs:

```bash
pnpm typecheck                                                    # 0 type errors
pnpm lint                                                         # --max-warnings=0
pnpm test                                                         # 134 files / 1416 tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml      # 128 passed / 13 ignored
pnpm build
pnpm build:binary
```

### Platform status

| Platform                          | Status                                                                                                                       |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **Linux** (CachyOS / Arch family) | Primary verified desktop environment. TypeScript and native suites, builds and isolated native startup are verified here.    |
| **macOS**                         | The native Rust suite builds and passes in CI (123 passed). No end-user machine was exercised and no installer was launched. |
| **Windows**                       | The native Rust suite builds and passes in CI (107 passed). No end-user machine was exercised and no installer was launched. |

## Verification

For the IRIS v0.3.2 candidate, verified on Linux:

| Suite                                   | Result                                      |
| :-------------------------------------- | :------------------------------------------ |
| TypeScript (`pnpm test`)                | **134 test files · 1416 passed · 0 failed** |
| Rust, Linux (`cargo test`)              | **128 passed · 0 failed · 13 ignored**      |
| Rust, `macos-14` runner                 | **123 passed · 0 failed · 10 ignored**      |
| Rust, `windows-latest` runner (`--lib`) | **107 passed · 0 failed · 9 ignored**       |

The Rust totals differ because Unix-only cases run only where the platform supports them; ignored tests are listed separately and are not counted as passed. The Windows step runs the library target because the manifest that lets a Windows test binary load cannot be applied to the binary target in the same invocation, and that target contains no tests.

Also verified: `pnpm typecheck`, zero-warning `pnpm lint`, `pnpm build`, `pnpm build:binary`, isolated native startup with no panic, browser and web safety paths (the visible browser runtime, the enforcing proxy and the native public-web reader), and persistence and recovery paths (revision-checked SQLite writes and content-checked restore points).

## Known limitations

IRIS states its gaps as plainly as its capabilities. Current product-scope limits:

- **Runtime verification is strongest on Linux.** macOS and Windows are covered by the native test suite on hosted CI runners, but no end-user machine was exercised and no installer was launched there.
- **Background work is Linux-specific.** The background runtime installs a per-user systemd unit; there is no launchd or Windows service implementation, and the full install/restart/crash/upgrade/removal lifecycle is unverified.
- **Channels are not equivalent.** Telegram supports inbox polling and approve/deny routing; Discord is an outgoing webhook sender only. Live remote identity and delivery are unverified for both, and channel updates IRIS could not apply are listed but cannot be resolved from inside the application.
- **Browser support is Linux-oriented.** Browser discovery assumes Linux executable paths, there is no persistent profile or multi-tab management, and the visible window is a real separate browser rather than an embedded live view.
- **Automated quality control is intentionally bounded.** There is no independent semantic evaluator and no automatic project replanning; acceptance combines saved human assessments with configured-evidence checks.
- **Office exports are simple.** DOCX, PDF, XLSX and PPTX output is real but plain: no rich layout, formulas, themes or rendered-artifact validation.
- **Restore points are limited in scope.** They cover native text writes and patches; shell changes, moves, deletes and binaries have no automatic undo.
- **External services need your credentials.** Hosted providers and optional integrations such as Firecrawl require your own API keys, and the in-app updater requires an asset signed with the matching production key.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the architectural rules — local-first behavior, UI isolation, permission gating and strict TypeScript — and [ROADMAP.md](ROADMAP.md) for direction.

## License

IRIS is open-source software licensed under the [MIT License](LICENSE).
