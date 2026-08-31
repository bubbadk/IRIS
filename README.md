# IRIS · Intelligent Reasoning & Integration System

<div align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" height="96" alt="IRIS Logo" />
  <h3>The Spatial Operating Environment for Autonomous AI Agents</h3>
  <p>An object-oriented, local-first desktop OS for creating, operating, and orchestrating autonomous AI agent systems.</p>

  [![Version](https://img.shields.io/badge/Version-0.2.3-blue.svg?style=flat-square)](https://github.com/bubbadk/IRIS/releases)
  [![FP-AMB Memory Benchmark](https://img.shields.io/badge/FP--AMB%20Memory%20Score-91.4%25%20(239.5%2F262)-success.svg?style=flat-square)](https://github.com/munch2u-a11y/FP-AMB)
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
- 🛸 **Project Flow Reactor (The Anti-Kanban)**: Live animated task matrices with visual step dependency chains and inline **`[ ✓ Apply ]`** / **`[ ✕ Deny ]`** approval gates.
- 🧠 **Elite Local Memory (91.4% FP-AMB Score)**: Multi-tier hybrid vector + BM25 lexical engine with temporal chrono-resolution and 18ms latency.
- ⚡ **Dual-Tier AI Architecture**: Run fast, affordable flash models for daily tasks, and seamlessly escalate to expert frontier models with instant **⚡ Takeover**.
- 🐙 **Live GitHub Release Engineering**: Autonomous issue triage, SemVer versioning, and CI/CD workflow automation that generates ready-to-run release binaries.
- 🛡️ **Zero-Surprise Security**: Interactive visual diff viewers, granular tool permission gating, and local OS Keyring credential storage.

```
                  ┌──────────────────────────────────────────────┐
                  │                 IRIS DESKTOP                 │
                  │   Spatial Object Windows & Command Stage     │
                  └──────────────┬────────────────┬──────────────┘
                                 │                │
             ┌───────────────────┴──┐          ┌──┴───────────────────┐
             │   Multi-Agent Cortex │          │   Live Telemetry HUD │
             │  Specialist Subagents│          │  Floating Mini Desklet│
             └───────────┬──────────┘          └──────────────────────┘
                         │
      ┌──────────────────┼──────────────────┬──────────────────┐
      ▼                  ▼                  ▼                  ▼
┌───────────┐      ┌───────────┐      ┌───────────┐      ┌───────────┐
│ GitHub    │      │ Workspace │      │  Vector   │      │ Provider  │
│ Operations│      │ Diff Gate │      │  Memory   │      │ (Ollama/  │
│ & CI/CD   │      │ Security  │      │ Retrieval │      │ OpenRouter│
└───────────┘      └───────────┘      └───────────┘      └───────────┘
```

---

## 🧠 Industry-Standard Memory Benchmark (FP-AMB v7.0)

IRIS was evaluated under **[FP-AMB (First-Person Agent Memory Benchmark)](https://github.com/munch2u-a11y/FP-AMB)** across a 60-session corpus comprising **679 conversation turns and 512,889 tokens**:

### 🏆 Scorecard Summary
- **Overall Accuracy:** **`91.4%`** (239.5 / 262 items passed)
- **Average Retrieval Latency:** **`18.31 ms`** per query (Pure local-first performance)
- **Ingestion Time:** **`0.11s`** for 512,889 tokens

| Evaluation Category | Accuracy | Result |
| :--- | :---: | :---: |
| 🛡️ **Speaker Attribution Traps** | **100.0%** | 14 / 14 |
| ⏱️ **Temporal Reasoning & Session Math** | **97.1%** | 34 / 35 |
| 🚫 **Absent Memory & Hallucination Refusal** | **94.3%** | 33 / 35 |
| 🔧 **Self-Referential & Procedural Tool Memory** | **93.5%** | 29 / 31 |
| 🕵️ **Adversarial Defense & Gaslighting Robustness** | **90.7%** | 39 / 43 |
| 🔄 **Adaptability & Fact Correction Overwrites** | **88.9%** | 16 / 18 |
| 🔍 **Single-Hop Fact Recall** | **88.6%** | 31 / 35 |
| ⚖️ **Source Credibility & Conflict Resolution** | **85.7%** | 6 / 7 |
| 🧠 **Cross-Session Multi-Hop Reasoning** | **85.2%** | 37.5 / 44 |
| 🏆 **TOTAL BENCHMARK SCORE** | **91.4%** | **239.5 / 262** |

---

## ✨ Key Features in v0.2.3

### 🛸 1. Project Flow Reactor (The Anti-Kanban)
Step beyond static cards and boring Kanban boards. The **Project Flow Reactor** brings your projects to life with live HUD streaming and dedicated spatial interaction stages:

- **Live HUD Stream**: Real-time project pulse in the right desktop sidebar under telemetry (`● Working`, `● Awaiting Decision`, `● Ready`, `✓ Done`).
- **Inline Permission Approvals**: Direct **`[ ✓ Apply ]`** and **`[ ✕ Deny ]`** buttons right on the project card when an autonomous worker requests tool execution.
- **Dedicated Project Flow Stage**: A focused spatial popup featuring an interactive task dependency chain (`Step 1 ➔ Step 2 ➔ Step 3`), dynamic step creation, and a live worker agent chat feed.

---

### 🌐 2. Web Search, Extraction, Image & Browser Tools
- **`web.search`**: Real-time web retrieval with summaries and URL citations.
- **`web.extract`**: Agent-grade full-page extraction powered by Firecrawl API with markdown cleanup.
- **`image.generate`**: Multimodal text-to-image synthesis (Flux, Stable Diffusion, DALL-E 3) with in-chat preview cards.
- **`browser.*` Suite**: Headless browser automation (`navigate`, `click`, `type`, `vision`) for agent driving primitives.

---

### ⚡ 3. Native 1-Click In-App Auto-Updater
- Real-time GitHub release discovery with live download progress bar.
- One-click seamless update installation and automatic application restart via Tauri 2.

---

### 🐙 4. GitHub Live Operations & Release Automation
- **Repository Explorer**: Inspect repositories with live stars, branches, issue counts, and visibility controls.
- **Automated SemVer Releases**: Tag new versions (`vMAJOR.MINOR.PATCH`), automatically author changelogs, and publish distribution binaries.

---

### ⚡ 5. Dual-Tier Intelligence & Instant "Takeover"
- **Cost-Optimized Everyday Models**: Configure fast models (*Qwen 2.5 Coder*, *DeepSeek V3*, *GPT-4o-mini*, *GLM 5.3 Flash*) for 90% of routine workflows.
- **⚡ Instant Takeover**: Click **`⚡ Takeover`** to immediately hand off active conversation context to expert reasoning models (*DeepSeek R1*, *Claude 3.7 Sonnet*, *Qwen 72B*).

---

## 🚀 Quickstart

### Download Standalone Release
Grab the latest pre-built binaries from [GitHub Releases](https://github.com/bubbadk/IRIS/releases):
- **Linux**: `.AppImage` or standalone binary (`iris-linux-x86_64-v0.2.3.tar.gz`)
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
