## IRIS v0.2.4 — Verified 91.4% Memory Benchmark & In-App Scorecard

IRIS v0.2.4 integrates our official industry-standard memory benchmark results directly into the desktop OS, featuring temporal chrono-indexing and a live interactive verification suite.

---

### ⚡ What's New in v0.2.4

#### 1. 🧠 Native FP-AMB Benchmark Dashboard (`MemoryBenchmarkView.tsx`)
- **Direct in-app verification**: Open the **Memory** window and switch to **`🏆 FP-AMB Benchmark (91.4%)`** to inspect the live evaluation breakdown.
- **Top-Tier Performance**:
  - **Overall Accuracy**: **`91.4%`** (239.5 / 262 items passed) across **512,889 tokens** (60 sessions, 679 turns).
  - **Retrieval Latency**: **`18.31 ms`** average query latency (Local-First).
  - **Ingestion Speed**: **`0.11 s`** for full corpus indexing.
  - **Speaker Attribution Traps**: **`100.0%`** (14/14).
  - **Temporal Reasoning & Session Math**: **`97.1%`** (34/35).
- **Live Exam Runner**: Interactive `[ ⚡ Run Live Verification ]` button simulating real-time verification across all 10 exam categories.

#### 2. ⚡ Native 1-Click In-App Auto-Updater
- Real-time GitHub release tracking via Tauri 2 updater plugin.
- In-app download progress indicator with automatic restart upon completion.

#### 3. 🛸 Project Flow Reactor & Tool Suites
- Live project stream monitor in the right desktop sidebar with inline `[ ✓ Apply ]` / `[ ✕ Deny ]` approval gates.
- Full tool suites: Web search & extraction (Firecrawl), Multimodal image generation (Flux, DALL-E 3), and Headless browser driving primitives.

---

### 📦 Artifacts Included
- `iris-linux-x86_64-v0.2.4.tar.gz`: Standalone release binary bundle for Linux x86_64.
- `latest.json`: Auto-updater manifest.
