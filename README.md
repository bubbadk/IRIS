# IRIS · Intelligent Reasoning & Integration System

<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" height="96" alt="IRIS Logo" />
  <h3>The Spatial Operating Environment for Autonomous AI Agents</h3>
  <p>An object-oriented, local-first desktop OS for creating, operating, and orchestrating autonomous AI agent systems.</p>

  [![Version](https://img.shields.io/badge/Version-0.2.9-blue.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![FP-AMB Memory Benchmark](https://img.shields.io/badge/FP--AMB%20(verified)-69.7%25%20(154%2F221%20gradeable)-success.svg?style=flat-square)](#-memory-benchmark-verified-results)
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
- 🧠 **Local Memory Engine**: BM25+ lexical retrieval with optional provider-backed embeddings, hybrid Reciprocal Rank Fusion, temporal query windows, multi-query recall, and duplicate-on-save protection. Measured at **1.63 ms/query** on local CPU.
- 🌌 **Memory Constellation**: A living star-map of what your agents actually remember — every memory is a star sized by retrieval frequency, memories retrieved together connect, and when an agent works, the memories it uses light up in rank order. Includes a timeline scrubber and click-through provenance.
- ⚡ **Dual-Tier AI Architecture**: Run fast, affordable flash models for daily tasks, and seamlessly escalate to expert frontier models with instant **⚡ Takeover**.
- 🐙 **Live GitHub Release Engineering**: Issue triage, SemVer versioning, and CI/CD workflow automation that generates ready-to-run release binaries.
- 🖥️ **Real Browser Automation**: Agents drive a genuine headless Chrome/Chromium session through the WebDriver protocol — trusted clicks, real keystrokes, element-ref snapshots, and PNG screenshots saved into the workspace.
- 🛡️ **Zero-Surprise Security**: Interactive visual diff viewers, granular tool permission gating, and local OS Keyring credential storage.
- 🔧 **v0.2.9 Internal Hardening**: Priority-aware history trimming (pinned system prompts never get silently dropped), configurable per-agent tool concurrency limits with async semaphore, Danish-language stemming and temporal parsing for memory fallback retrieval, smarter schedule reconciliation that re-queues never-started runs instead of failing them, structured turn-trace observability for debugging agent decision paths, and a full App.tsx decomposition from 4816 lines to 487 across five extracted feature modules.

---

## 🧠 Memory Benchmark — Verified Results

IRIS is evaluated against the [FP-AMB question suite](https://github.com/munch2u-a11y/FP-AMB) (262 questions over a 60-session, 739-turn corpus). **The grading is strict, word-boundary based, and reproducible** — every number below can be regenerated by running the in-app *Live Verification* (Memory → FP-AMB Benchmark) or `packages/memory`'s test suite.

### Measured scorecard (2026-09-01, LocalLexicalMemoryRetriever, top-5)

> **A note on ambition:** IRIS is not chasing the top score on memory benchmarks. A 100% score means nothing if the grading is fake. **Quality comes first** — honest grading, reproducible numbers, and a retrieval engine you can audit beat a flattering leaderboard position. If the score is 69.7% today, that is what it is; improvements will be earned, measured, and published with the full grading path open for inspection.

- **Overall accuracy: `69.7%`** (154 / 221 automatically gradeable questions)
- **41 of 262 questions are excluded by design**: 35 refusal questions require agent-in-the-loop semantic grading and 6 judgment questions require an LLM judge. Excluding them is the honest choice — auto-passing them would inflate the score (the previous fabricated results did exactly that).
- **Measured retrieval latency:** `1.63 ms`/query (pure local CPU)
- **Corpus:** 60 sessions · 739 turns · 819,273 indexed tokens (whitespace count, measured)

| Category | Accuracy | Result |
| :--- | :---: | :---: |
| ⚖️ Source Credibility & Conflict Resolution | **100.0%** | 5 / 5 |
| 🛡️ Speaker Attribution Traps | **92.9%** | 13 / 14 |
| 🔧 Self-Referential & Procedural Tool Memory | **80.6%** | 25 / 31 |
| 🕵️ Adversarial Defense & Gaslighting Robustness | **74.4%** | 29 / 39 |
| 🔄 Adaptability & Fact Correction Overwrites | **72.2%** | 13 / 18 |
| 🔍 Single-Hop Fact Recall | **74.3%** | 26 / 35 |
| 🧠 Cross-Session Multi-Hop Reasoning | **61.4%** | 27 / 44 |
| ⏱️ Temporal Reasoning & Session Math | **45.7%** | 16 / 35 |
| 🚫 Unanswerable & Absent Memory Refusal | N/A | 35 ungraded (semantic grading required) |
| 🏆 **TOTAL (gradeable)** | **69.7%** | **154 / 221** |

**Retraction:** earlier README versions published 91.4% and 83.6% on this benchmark. Both figures came from grading that auto-passed refusal questions, used naive substring matching, and included hardcoded constants (a fixed "512,889 tokens indexed" and a fabricated ingestion-time figure). They cannot be reproduced with the current, auditable grader and are officially retracted.

---

## ✨ Key Features in v0.2.8

### 🌐 1. Real Browser Automation (WebDriver)
- **Genuine headless Chrome/Chromium session**: `browser.start` launches a real browser through chromedriver, managed from IRIS's Rust backend via the WebDriver protocol — no simulation anywhere.
- **Trusted clicks & real keystrokes**: `browser.click` (by snapshot ref, CSS selector, or visible text) and `browser.type` (real send-keys) drive actual input events; `browser.snapshot` refreshes clickable element refs.
- **Honest vision**: `browser.vision` saves a real PNG screenshot into the workspace (`iris-vision/`) — a file you can open, not base64 a model cannot see. Without a running session, `browser.navigate`/`browser.vision` fall back to plain HTTP fetching and say so in the result.

---

### 🛠️ 2. Sandboxed Workspace Shell & Agent Teams
- **`shell.exec`**: agents run one real shell command inside the mounted workspace root, gated by the standard `[ ✓ Apply ]` / `[ ✕ Deny ]` permission flow, with process-group timeouts (1–300 s) and 64 KiB output caps.
- **`cortex.delegate-team`**: fan a task out to up to four specialist sub-agents running concurrently, with per-member reports and a `completed / partial / failed` rollup.

---

### 💬 3. Composer & Desktop Polish
- **Drag-and-drop attachments**: drop files from your file manager straight onto either chat composer (images become vision blocks, text files become fenced labeled blocks).
- **Ctrl/Cmd+K command palette**: keyboard-first launcher that filters every desktop object and opens it as a window.
- **Subtitle Studio (chunked dialogue translator)**: SRT/VTT ingestion with a sliding context window, dual-pane live preview, and zero timestamp drift.
- **Project Flow Reactor (The Anti-Kanban)**: live task dependency chains, worker chat feed, and inline permission approvals.
- **Web & image tools**: `web.search`, `web.extract` (Firecrawl), and `image.generate` with availability probing before success is reported.
- **Native 1-click in-app auto-updater** with live download progress and automatic restart via Tauri 2.

---

## 🚀 Quickstart

### Download Standalone Release
Grab the latest pre-built binaries from [GitHub Releases](https://github.com/bubbadk/IRIS/releases):
- **Linux**: standalone binary (`iris-linux-x86_64-v0.2.8.tar.gz`) or `.AppImage`
- **macOS**: `.dmg` (Universal binary)
- **Windows**: `.msi` / `.exe` installer

Existing installations update in-app: the built-in updater polls `latest.json` from the newest release.

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
