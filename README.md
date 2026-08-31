# IRIS · Intelligent Reasoning & Integration System

<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" height="96" alt="IRIS Logo" />
  <h3>The Spatial Operating Environment for Autonomous AI Agents</h3>
  <p>An object-oriented, local-first desktop OS for creating, operating, and orchestrating autonomous AI agent systems.</p>

  [![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![FP-AMB Memory Benchmark](https://img.shields.io/badge/FP--AMB%20Memory%20Score-83.6%25%20(219%2F262)-success.svg?style=flat-square)](https://github.com/munch2u-a11y/FP-AMB)
  [![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-Linux%20(CachyOS%2FArch%20%7C%20Ubuntu)%20%7C%20macOS%20%7C%20Windows-amber.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![Build](https://img.shields.io/badge/Build-Native%20AppImage%20%7C%20Tauri%202-purple.svg?style=flat-square)](https://github.com/bubbadk/IRIS)
</div>

<br />

<div align="center">
  <img src="docs/screenshots/iris-spatial-desktop-v020.png" alt="IRIS Spatial Operating Environment" width="100%" style="border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,0.12);" />
</div>

---

## 🌟 Why IRIS?

Most AI agent tools are just single-stream chat boxes with a generic dashboard attached. **IRIS is fundamentally different:**

IRIS is a **graphical agent operating environment**. It treats agents, workspaces, tools, memory graphs, and scheduled workflows as **first-class spatial desktop objects** that you can arrange, inspect, run concurrently, and monitor in real time.

- 🌿 **Warm, Calming Aesthetic**: Zero dark cyberpunk neon clichés or dense terminal grids. A serene, object-oriented desktop designed for deep work.
- 💬 **Subtitle Studio**: Chunked SRT/VTT subtitle translator with zero timestamp drift and natural colloquial phrasing.
- 🛸 **Project Flow Reactor (The Anti-Kanban)**: Live animated task matrices with visual step dependency chains and inline **`[ ✓ Apply ]`** / **`[ ✕ Deny ]`** approval gates.
- 🧠 **Local Memory (83.6% FP-AMB Score)**: Okapi BM25+ inverted index engine with sliding dialogue context and 1.42ms query latency.
- ⚡ **Dual-Tier AI Architecture**: Run fast, affordable flash models for daily tasks, and seamlessly escalate to expert frontier models with instant **⚡ Takeover**.
- 🐙 **Live GitHub Release Engineering**: Autonomous issue triage, SemVer versioning, and CI/CD workflow automation that generates ready-to-run release binaries.
- 🛡️ **Zero-Surprise Security**: Interactive visual diff viewers, granular tool permission gating, and local OS Keyring credential storage.

---

## 🧠 Industry-Standard Memory Benchmark (FP-AMB v7.0)

IRIS was evaluated under **[FP-AMB (First-Person Agent Memory Benchmark)](https://github.com/munch2u-a11y/FP-AMB)** across a 60-session corpus comprising **739 conversation turns and 512,889 tokens**:

### 🏆 Scorecard Summary
- **Overall Accuracy:** **`83.6%`** (219 / 262 items passed)
- **Average Retrieval Latency:** **`1.42 ms`** per query (Pure local CPU execution)
- **Ingestion Time:** **`5 ms`** for 512,889 tokens

| Evaluation Category | Accuracy | Result |
| :--- | :---: | :---: |
| 🕵️ **Adversarial Defense & Gaslighting Robustness** | **100.0%** | 43 / 43 |
| ⚖️ **Source Credibility & Conflict Resolution** | **100.0%** | 7 / 7 |
| 🛡️ **Speaker Attribution Traps** | **92.9%** | 13 / 14 |
| 🚫 **Absent Memory & Hallucination Refusal** | **91.4%** | 32 / 35 |
| 🔧 **Self-Referential & Procedural Tool Memory** | **90.3%** | 28 / 31 |
| 🔄 **Adaptability & Fact Correction Overwrites** | **83.3%** | 15 / 18 |
| 🧠 **Cross-Session Multi-Hop Reasoning** | **77.3%** | 34 / 44 |
| 🔍 **Single-Hop Fact Recall** | **74.3%** | 26 / 35 |
| ⏱️ **Temporal Reasoning & Session Math** | **60.0%** | 21 / 35 |
| 🏆 **TOTAL BENCHMARK SCORE** | **83.6%** | **219 / 262** |

---

## ✨ Key Features in v0.2.5

### 💬 1. Subtitle Studio (Chunked Dialogue Translator)
- **Sliding Context Window**: Slices large `.srt` and `.vtt` files into manageable batches while preserving dialogue context to maintain character voice and idioms.
- **Timestamp Integrity**: Reassembles translated subtitles with exact millisecond start/end timestamps.
- **Dual-Pane Live Stream**: Interactive side-by-side view with live progress, pause/resume, and direct 1-click download.

---

### 🛸 2. Project Flow Reactor (The Anti-Kanban)
- **Live HUD Stream**: Real-time project pulse in the right desktop sidebar under telemetry (`● Working`, `● Awaiting Decision`, `● Ready`, `✓ Done`).
- **Inline Permission Approvals**: Direct **`[ ✓ Apply ]`** and **`[ ✕ Deny ]`** buttons right on the project card when an autonomous worker requests tool execution.
- **Dedicated Project Flow Stage**: A focused spatial popup featuring an interactive task dependency chain (`Step 1 ➔ Step 2 ➔ Step 3`), dynamic step creation, and a live worker agent chat feed.

---

### 🌐 3. Web Search, Extraction, Image & Browser Tools
- **`web.search`**: Real-time web retrieval with summaries and URL citations.
- **`web.extract`**: Agent-grade full-page extraction powered by Firecrawl API with markdown cleanup.
- **`image.generate`**: Multimodal text-to-image synthesis (Flux, Stable Diffusion, DALL-E 3) with in-chat preview cards.
- **`browser.*` Suite**: Headless browser automation (`navigate`, `click`, `type`, `vision`) for agent driving primitives.

---

### ⚡ 4. Native 1-Click In-App Auto-Updater
- Real-time GitHub release discovery with live download progress bar.
- One-click seamless update installation and automatic application restart via Tauri 2.

---

## 🚀 Quickstart

### Download Standalone Release
Grab the latest pre-built binaries from [GitHub Releases](https://github.com/bubbadk/IRIS/releases):
- **Linux**: `.AppImage` or standalone binary (`iris-linux-x86_64-v0.2.5.tar.gz`)
- **macOS**: `.dmg` (Universal binary)
- **Windows**: `.msi` / `.exe` installer

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
| [`packages/memory`](packages/memory) | Vector embeddings, semantic search, and idle memory consolidation |
| [`packages/providers`](packages/providers) | Unified LLM provider contracts (OpenRouter, Ollama, Anthropic, OpenAI, Gemini) |
| [`packages/skills`](packages/skills) | Sandboxed skill execution and capability scanning |
| [`packages/tools`](packages/tools) | Tool execution engine, audit trails, and permission policy enforcement |
| [`packages/workflows`](packages/workflows) | DAG task graphs, cron scheduler, and dreaming consolidation |
| [`packages/workspaces`](packages/workspaces) | Safe local directory mounting, patch generation, and visual diff tracking |

---

## 📄 License

IRIS is open-source software licensed under the [MIT License](LICENSE).
