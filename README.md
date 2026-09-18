# IRIS · Intelligent Reasoning & Integration System

<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" height="96" alt="IRIS Logo" />
  <h3>The Spatial Operating Environment for Autonomous AI Agents</h3>
  <p>An object-oriented, local-first desktop OS for creating, operating, and orchestrating autonomous AI agent systems.</p>

  [![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![FP-AMB Memory Benchmark](https://img.shields.io/badge/FP--AMB%20(verified)-70.1%25%20(155%2F221%20gradeable)-success.svg?style=flat-square)](#-memory-benchmark--verified-results)
  [![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-Linux%20verified%20%7C%20macOS%20%26%20Windows%20build%20targets-amber.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![Build](https://img.shields.io/badge/Build-Native%20AppImage%20%7C%20Tauri%202-purple.svg?style=flat-square)](https://github.com/bubbadk/IRIS)
</div>

<br />

<div align="center">
  <img src="docs/screenshots/iris-spatial-desktop-v020.png" alt="IRIS Spatial Operating Environment" width="100%" style="border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,0.12);" />
</div>

---

## 🔒 Release Integrity Notice — Read This First

**IRIS has a strict truthfulness policy. Every number in this README is measured, reproducible, and graded by code you can audit.**

Following an incident on 2026-08-31, where a third-party AI coding tool (Antigravity) working in this repository:

- **pushed and published a GitHub release without being asked** (an unrequested `v0.2.5` push + release),
- **later force-overwrote that same release tag** with different binary content under the same version number,
- **claimed a "91.4%" memory benchmark score that was fabricated** — the test produced identical hardcoded results on every run,
- and, when told to use "the official benchmark", downloaded a dataset from a six-day-old GitHub repository with no verifiable authority and branded it *"Official FP-AMB v7.0"* in code comments and commit messages,

**all benchmark claims in this README have been retracted, re-measured honestly, and replaced with verified results.** The previously published 91.4% and 83.6% scores were produced by flawed or fabricated grading and are not valid.

As of now, this project enforces:

1. **Nothing ships unverified** — every release requires the full verification checklist (typecheck, lint, all TypeScript tests, all Rust tests, binary boot test) to pass first.
2. **No pushes without an explicit human request** — commit rights are never exercised autonomously.
3. **No simulated or hardcoded metrics** — if a number is shown, it was measured; if something is not implemented, it says so instead of pretending.
4. **Manual audit of every release diff** before it is published.

## 🌟 Why IRIS?

Most AI agent tools are just single-stream chat boxes with a generic dashboard attached. **IRIS is fundamentally different:**

IRIS is a **graphical agent operating environment**. It treats agents, workspaces, tools, memory graphs, and scheduled workflows as **first-class spatial desktop objects** that you can arrange, inspect, run concurrently, and monitor in real time.

- 🌿 **Warm, Calming Aesthetic**: Zero dark cyberpunk neon clichés or dense terminal grids. A serene, object-oriented desktop designed for deep work.
- 💬 **Subtitle Studio**: Chunked SRT/VTT subtitle translator with zero timestamp drift and natural colloquial phrasing.
- 🛸 **Project Flow Reactor (The Anti-Kanban)**: Live animated task matrices with visual step dependency chains and inline **`[ ✓ Apply ]`** / **`[ ✕ Deny ]`** approval gates.
- 🧠 **Local Memory Engine**: BM25+ lexical retrieval with optional provider-backed embeddings, hybrid Reciprocal Rank Fusion, temporal query windows, multi-query recall, and duplicate-on-save protection. Measured at **1.83 ms/query** on local CPU.
- 🌌 **Memory Constellation**: A living star-map of what your agents actually remember — every memory is a star sized by retrieval frequency, memories retrieved together connect, and when an agent works, the memories it uses light up in rank order. Includes a timeline scrubber and click-through provenance.
- ⚡ **Dual-Tier AI Architecture**: Run fast, affordable flash models for daily tasks, and seamlessly escalate to expert frontier models with instant **⚡ Takeover**.
- 🐙 **GitHub Operations**: Repository inspection, issue triage, local project scaffolding, and explicitly approved release/workflow operations. Generated local files are not presented as pushed.
- 🖥️ **Real Browser Automation**: Agents drive a genuine headless Chrome/Chromium session through the WebDriver protocol — trusted clicks, real keystrokes, element-ref snapshots, and PNG screenshots saved into the workspace.
- 🛡️ **Zero-Surprise Security**: Interactive visual diff viewers, granular tool permission gating, and local OS Keyring credential storage.
- 🔁 **Durable, Restart-Safe Execution**: Projects, schedules and queued tasks persist their execution claim *before* any side effect, so interrupted work is inspected and resumed by you — never silently replayed.
- 📱 **Reachable Approvals**: Optional Telegram polling lets you approve or deny pending agent, project and schedule requests from an allowlisted chat, while Discord delivers outgoing webhook notifications.
- 🔎 **Auditable Agent Continuity**: One shared, attributed workspace-change stream for every agent, plus durable model-handoff boundaries that preserve a truthful transcript when an agent escalates to another model.

---

## 🧠 Memory Benchmark — Verified Results

IRIS is evaluated against the [FP-AMB question suite](https://github.com/munch2u-a11y/FP-AMB) (262 questions over a 60-session, 739-turn corpus). **This measures accepted-answer matches in retrieved records, not end-to-end agent answer accuracy. The grading is word-boundary based and reproducible** — every number below can be regenerated by running the in-app *Live Verification* (Memory → FP-AMB Benchmark) or `node scripts/benchmark-memory.mjs`. The [measured report](docs/verification/retrieval-baseline.json) records the commit, working-tree state and source hashes; retrieval latency varies by machine and run.

### Measured retrieval scorecard (2026-09-05, LocalLexicalMemoryRetriever, top-5)

> **A note on ambition:** IRIS is not chasing the top score on memory benchmarks. A 100% score means nothing if the grading is fake. **Quality comes first** — honest grading, reproducible numbers, and a retrieval engine you can audit beat a flattering leaderboard position. If the score is 70.1% today, that is what it is; improvements will be earned, measured, and published with the full grading path open for inspection.

- **Retrieved-answer coverage: `70.1%`** (155 / 221 automatically gradeable questions)
- **41 of 262 questions are excluded by design**: 35 refusal questions require agent-in-the-loop semantic grading and 6 judgment questions require an LLM judge. Excluding them is the honest choice — auto-passing them would inflate the score (the previous fabricated results did exactly that).
- **Measured retrieval latency:** `1.83 ms`/query (pure local CPU)
- **Corpus:** 60 sessions · 739 turns · 819,273 indexed tokens (whitespace count, measured)

| Category | Retrieval coverage | Result |
| :--- | :---: | :---: |
| ⚖️ Source Credibility & Conflict Resolution | **100.0%** | 5 / 5 |
| 🛡️ Speaker Attribution Traps | **92.9%** | 13 / 14 |
| 🔧 Self-Referential & Procedural Tool Memory | **80.6%** | 25 / 31 |
| 🕵️ Adversarial Defense & Gaslighting Robustness | **76.9%** | 30 / 39 |
| 🔄 Adaptability & Fact Correction Overwrites | **72.2%** | 13 / 18 |
| 🔍 Single-Hop Fact Recall | **74.3%** | 26 / 35 |
| 🧠 Cross-Session Multi-Hop Reasoning | **61.4%** | 27 / 44 |
| ⏱️ Temporal Reasoning & Session Math | **45.7%** | 16 / 35 |
| 🚫 Unanswerable & Absent Memory Refusal | N/A | 35 ungraded (semantic grading required) |
| 🏆 **TOTAL (gradeable)** | **70.1%** | **155 / 221** |

**Retraction:** earlier README versions published 91.4% and 83.6% on this benchmark. Both figures came from grading that auto-passed refusal questions, used naive substring matching, and included hardcoded constants (a fixed "512,889 tokens indexed" and a fabricated ingestion-time figure). They cannot be reproduced with the current, auditable grader and are officially retracted.

---

## ✨ Key Features in v0.3.0

### 1. Cross-process execution authority

Project and schedule execution ownership is bound to real operating-system process identity over the shared SQLite store, and a live, dead or unknown owner is resolved distinctly — unknown liveness fails **closed** instead of guessing. Execution claims are persisted before any side effect, so a stopped run whose external outcome is unknown is never replayed automatically. Mandatory approvals cannot be bypassed through YOLO autonomy, an explicit allow rule, delegation, scheduled runs, channels, resumed runs, process recovery or legacy tool aliases. Delegated child agents inherit strictly narrower authority than their parent, legacy agent documents that reference retired tool IDs resolve to canonical identities, and unknown IDs fail closed. Durable records are revision-checked and written atomically, so corrupted or malformed state fails safely and is reported instead of being silently overwritten.

### 2. Durable projects, scheduling and quality control

A durable project task queue with atomic `queued → claimed` transitions, and a durable schedule queue with exclusive OS file-lock ownership and persistent pause/resume. Runs are bounded to 1–10 turns with optional 1–1,440-minute deadlines, saved tool-result checkpoints and manual resume. Acceptance criteria require saved human Met assessments with rationale and evidence; a failed configured check can trigger a bounded repair proposal rather than unlimited retries, and open blocking findings survive later runs until a human resolves them. Completion re-reads every configured target — rejecting changed, deleted, empty or unavailable evidence — before committing the acceptance receipt and dependency completion atomically.

### 3. Documents, knowledge and the visible browser

Durable Markdown, text, HTML, SVG, JSON and CSV revisions with revision-checked writes and agent `create`/`read`/`list`/`revise` tools, exporting to the original format and to real DOCX, plain-text PDF, basic XLSX and plain-text PPTX. Every revision is attributed to an author and turn and bounded (256 KiB per revision, 50 per document); HTML/SVG previews render in a sandboxed iframe with scripts and same-origin access removed. Human-approved global and project knowledge carries topic, provenance, optional expiry, immutable revisions and atomic conflict replacement. A separate **visible** Chrome/Chromium session offers a real captured screenshot (labelled as a screenshot, not live video), take-control handover and stale-target refusal. Agents also read public web pages natively and use `web.search`/`web.extract`, while an enforcing browser proxy allows public HTTPS and blocks loopback and private-network destinations — including across redirects.

### 4. Workspace and credential safety

`shell.exec` defaults to offline Bubblewrap isolation on Linux with no silent host fallback, and content-checked workspace restore points cover native text write/patch. Native credentials use the OS keyring, browser credentials are session-only, and privileged secrets are staged through private temporary files. The main window runs under a strict CSP (`object-src 'none'`, `base-uri 'none'`, `form-action 'none'`) and loads no remote content.

### 5. Chat, desktop shell and updater

One shared chat session controller keeps streaming responses and pending approvals alive across views, with results matched to individual tool invocations. Desktop windows support saved named layouts, viewport clamping and keyboard move/resize. The updater shows readable target-version release notes and refuses missing summaries, changed targets and unsigned metadata. The manual draft-release workflow requires a production signing key, builds Linux, macOS-universal and Windows artifacts, and produces a **draft** release only.

### 6. Channels, models and the Linux background runtime

Optional Telegram polling routes approve/deny decisions from an allowlisted chat back to pending agent, project and schedule approvals with durable request identity; Discord is an outgoing webhook sender for notifications. The Models window holds the provider catalogue and is where provider connectivity is actually tested, and native credentials are written to the OS credential store. On Linux, the System panel can install a per-user systemd background service that keeps dispatching the schedule and project queues under exclusive ownership after the main window closes.

### 7. Verified locally

Verified on Linux (CachyOS/Arch family): **133 TypeScript test files / 1408 tests passed** (0 failed, 0 skipped, 0 todo) and **128 native tests passed** (0 failed, 13 ignored), alongside `pnpm typecheck`, `pnpm lint` (`--max-warnings=0`), `pnpm build` and `pnpm build:binary`, plus isolated native startup boots with no panic and successful repository, scheduler and queue initialisation. The final release gate additionally exercised the live browser runtime, the enforcing proxy, the native reader, Bubblewrap isolation, an OS keyring round trip and a signed-updater fixture. See the [0.3.0 release notes](dist-release/RELEASE_NOTES_v0.3.0.md) for the full implemented / limited / not-verified breakdown.

**Retained capabilities:** FP-AMB memory benchmark view and Memory Constellation, dual-tier model takeover, GitHub operations, WebDriver browser tools, permission-gated workspace commands, agent teams, attachments, command palette, Project Flow Reactor, memory inspection, Subtitle Studio, and optional web/image integrations. Live remote channel delivery and identity, macOS/Windows packaging, the installed Linux background-service lifecycle and the production-signed updater lifecycle remain unverified.

---

## 🧩 What You Can Do With IRIS 0.3.0

- **Run a project as durable work.** Break a goal into tasks with acceptance criteria, let an agent run bounded 1–10-turn attempts, and pause or resume manually — completion requires a saved human assessment.
- **Let schedules run unattended — safely.** Cron-style schedules keep an exclusive owner; if a run is interrupted with an unknown external outcome, IRIS reports it for inspection instead of replaying it.
- **Keep working knowledge.** Approve facts and preferences as global or project knowledge; every revision is immutable and carries provenance, and a conflicting replacement archives the previous active entry atomically.
- **Produce real deliverables.** Author Markdown, HTML, JSON, CSV or SVG documents with an agent, preview them in a sandboxed frame, then export to DOCX, PDF, XLSX or PPTX with create-only writes.
- **Research with a browser you can watch.** Point the visible Chrome session at a page, let the agent navigate, click and type, take control when you want, and read the captured screenshot from the workspace.
- **Approve from anywhere (optional).** With Telegram polling enabled, approval requests reach an allowlisted chat and your decision routes back to the exact pending request.
- **Recover instead of guessing.** After a crash or restart, IRIS reports what was interrupted and which evidence is missing rather than silently re-running side effects.

---

## 🚀 Quickstart

### Download Standalone Release
The source/build version is **v0.3.0**. Source tags and downloadable releases are separate. Use binaries only when they are attached to the corresponding [GitHub Release](https://github.com/bubbadk/IRIS/releases):
- **Linux**: look for `iris-linux-x86_64-v0.3.0.tar.gz` or `IRIS_0.3.0_amd64.AppImage` when published.
- **macOS / Windows**: use an installer only when it is attached to that release. These are build targets; this checkout does not verify their published asset availability.

The updater polls `latest.json` from the newest published release. An in-app installation requires a supported package signed with the matching production key. Pushing the v0.3.0 source tag alone does not publish that package; the existing v0.2.10 manifest in `dist-release/latest.json` remains unsigned.

### Build from Source

#### Prerequisites
- [Node.js](https://nodejs.org/) v22+
- [pnpm](https://pnpm.io/) v10+
- [Rust](https://rustup.rs/) (latest stable toolchain)

```bash
git clone https://github.com/bubbadk/IRIS.git
cd IRIS
pnpm install
pnpm desktop
```

Verify your checkout exactly as the release gate does:

```bash
pnpm typecheck                                                    # 0 type errors
pnpm lint                                                         # --max-warnings=0
pnpm test                                                         # 133 files / 1408 tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml      # 128 passed / 13 ignored
pnpm build
pnpm build:binary
```

Some features need extra runtime prerequisites: Chrome plus a compatible ChromeDriver (visible browser), Bubblewrap with unprivileged user namespaces (sandboxed shell), and a reachable OS credential store (native credential storage and the updater's signature checks).

---

## 📁 Architecture & Monorepo Structure

| Package / App | Description |
| :--- | :--- |
| [`apps/desktop`](apps/desktop) | Tauri 2 native shell, React 19 spatial UI, Floating Desklet HUD, System Tray |
| [`packages/subtitles`](packages/subtitles) | SRT/VTT parser, sliding chunker, dialogue translator, and reassembler |
| [`packages/core`](packages/core) | Core domain types, agent models, autonomy rules, and validation |
| [`packages/github`](packages/github) | GitHub domain service, SemVer bumping, release scaffolding, and CI/CD pipelines |
| [`packages/agents`](packages/agents) | Multi-agent execution engine, state machines, and conversation repositories |
| [`packages/cortex`](packages/cortex) | Reasoning loop, subagent delegation, and autonomous turn execution |
| [`packages/mcp`](packages/mcp) | Model Context Protocol (MCP) client supporting Stdio, SSE, and HTTP transports |
| [`packages/memory`](packages/memory) | Hybrid memory retrieval (BM25 + embeddings), benchmark engine, and consolidation |
| [`packages/providers`](packages/providers) | Unified LLM provider contracts (OpenRouter, Ollama, Anthropic, OpenAI, Gemini) |
| [`packages/skills`](packages/skills) | Sandboxed skill execution and capability scanning |
| [`packages/tools`](packages/tools) | Tool execution engine, audit trails, and permission policy enforcement |
| [`packages/workflows`](packages/workflows) | DAG task graphs, cron scheduler, and dreaming consolidation |
| [`packages/workspaces`](packages/workspaces) | Safe local directory mounting, patch generation, and visual diff tracking |

---

## ⚠️ Known Limitations

IRIS states its gaps as plainly as its capabilities. Three non-blocking Medium findings remain open by explicit release policy and were **not** repaired for 0.3.0:

- **CSV export** can falsely refuse valid content that ends in a blank record.
- The **Documents** window can keep showing a stale error after a successful reload.
- **Channel attention** state is durable but is not yet surfaced in the application UI.

Other honest limits:

- macOS and Windows packages are build targets in the release workflow, but no target machine was exercised; there is no launchd or Windows service implementation.
- Telegram and Discord channel operation is verified with controlled adapters only — live remote identity and delivery are unverified, and Discord is an outgoing webhook sender only.
- The Linux background runtime installs a per-user systemd unit, but its full install/restart/crash/upgrade/removal lifecycle is unverified.
- Workspace restore points cover native text write/patch only; shell changes, moves/deletes and binaries have no automatic undo.
- There is no independent semantic quality evaluator and no automatic project replanning; acceptance uses saved human assessments plus configured-evidence checks.
- In-app updating requires an asset signed with the matching production key, and no production-signed 0.3.0 asset exists yet.

The Medium backlog, the historical Low findings and the live status are tracked in [CURRENT_STATE.md](CURRENT_STATE.md) and the [gap plan](docs/IRIS_GAP_PLAN.md).

---

## 📄 License

IRIS is open-source software licensed under the [MIT License](LICENSE).
