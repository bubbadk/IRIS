# IRIS · Intelligent Reasoning & Integration System

<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" height="96" alt="IRIS Logo" />
  <h3>The Spatial Operating Environment for Autonomous AI Agents</h3>
  <p>An object-oriented, local-first desktop OS for creating, operating, and orchestrating autonomous AI agent systems.</p>

  [![Version](https://img.shields.io/badge/Version-0.2.11-blue.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![FP-AMB Memory Benchmark](https://img.shields.io/badge/FP--AMB%20(verified)-70.1%25%20(155%2F221%20gradeable)-success.svg?style=flat-square)](#-memory-benchmark-verified-results)
  [![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-Linux%20(CachyOS%2FArch%20%7C%20Ubuntu)%20%7C%20macOS%20%7C%20Windows-amber.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
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

## ✨ Key Features in v0.2.11

### 1. Durable native storage

Native repositories now use SQLite with revision-checked atomic writes. Concurrent changes retry against current data, and failed writes preserve existing history and attachments. Startup imports repository data from the active localStorage origin once and retains the original data as a backup; corrupt JSON stops the whole migration. Browser preview, credentials, UI preferences and subtitle checkpoints keep their separate stores.

### 2. Reliable chat and tool approvals

The Agent, Desklet and GitHub views share a chat session controller. Streaming responses and pending approvals survive view changes. Consecutive approvals stay visible, and results are matched to individual tool invocations. Approved execution is claimed atomically before side effects; interrupted invocations cannot be automatically replayed when their outcome is unknown. GitHub chat now presents Apply/Deny controls.

### 3. Truthful desktop status and secure connections

Desklet activity follows real running agents and project workers, including across native webviews. Missing telemetry is shown as unavailable. Telegram/Discord credentials use the OS credential store, with verified migration before legacy secrets are removed. These connections currently support outgoing test messages only; incoming messages, remote approvals and automatic notifications are not connected. Live delivery still awaits a configured test recipient.

### 4. Resumable subtitles and saved desktop layouts

Subtitle translation runs outside React window lifetimes, checkpoints partial progress and can be manually resumed after restart. Untranslated cues remain unfinished. Desktop windows support saved named layouts, viewport clamping and keyboard movement/resizing through their title bars.

### 5. Verified updater behavior and Linux packaging

The updater shows readable release notes for the target version and refuses missing summaries, changed targets and unsigned metadata. A real AppImage has passed local signed download, installation, tamper rejection, failed-extraction rollback and restart tests using disposable keys. Production signing credentials are still required for an installable published update.

`pnpm build:appimage` handles Arch/CachyOS `.relr.dyn` library sections by retaining dependency symbols instead of invoking linuxdeploy's obsolete strip tool. The manual draft-release workflow requires a signing key and generates updater artifacts; it is not triggered by pushing this source version. A successful local AppImage test does not establish portability to every Linux distribution.

### 6. Smaller modules, bounded output and reproducible verification

Agent editing, tool traces, shared chat content, GitHub state and dialogs are separate modules. Workspace and Janitor output pipes are drained while retaining at most 64 KiB plus a truncation marker. Benchmark data loads on demand, and the exported report distinguishes retrieved-answer coverage from final-answer accuracy.

**Verified locally:** 530 TypeScript tests in 62 suites; 46 ordinary native tests plus OS keyring and signed-updater integration tests; typecheck and lint with zero warnings; native boot/restart with retained data. See the [verification record](docs/verification/hardening-status.md) and [signed AppImage results](docs/verification/signed-updater-result.json).

**Retained capabilities:** attributed workspace-change history and model-handoff markers from v0.2.10, real WebDriver browser tools, permission-gated workspace commands, agent teams, attachments, command palette, Project Flow Reactor, memory inspection, and optional web/image integrations. Workspace commands start in the mounted folder; they are not an OS-level sandbox.

---

## 🚀 Quickstart

### Download Standalone Release
The source/build version is **v0.2.11**. Source tags and downloadable releases are separate. Use binaries only when they are attached to the corresponding [GitHub Release](https://github.com/bubbadk/IRIS/releases):
- **Linux**: look for `iris-linux-x86_64-v0.2.11.tar.gz` or `IRIS_0.2.11_amd64.AppImage` when published.
- **macOS / Windows**: use an installer only when it is attached to that release. These are build targets; this checkout does not verify their published asset availability.

The updater polls `latest.json` from the newest published release. An in-app installation requires a supported package signed with the matching production key. Pushing the v0.2.11 source tag alone does not publish that package; the existing v0.2.10 manifest in `dist-release/latest.json` remains unsigned.

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

## 📄 License

IRIS is open-source software licensed under the [MIT License](LICENSE).
