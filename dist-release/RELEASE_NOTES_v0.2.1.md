## IRIS v0.2.1 — Project Flow Reactor & Capability Suites

IRIS v0.2.1 introduces a major evolution to autonomous project workflows, along with new agent tool suites for web search, full-page extraction, multimodal image generation, and headless browser driving primitives.

---

### ⚡ What's New in v0.2.1

#### 1. 🔴 Live Project Flow Stream (HUD Live Section)
- **Live Project Status Pulse**: Integrated into the right desktop HUD sidebar directly beneath the machine telemetry console.
- **Real-Time Task Monitoring**: Displays live task milestone states (`● Working`, `● Awaiting Decision`, `● Ready`, `✓ Done`).
- **Inline Permission Approvals**: Direct **`[ ✓ Apply ]`** and **`[ ✕ Deny ]`** action buttons rendered on the project card when an autonomous worker requests tool permissions (file writes, terminal execution, etc.).
- **Click-to-Open**: Clicking any card in the stream opens its dedicated Project Flow Reactor stage.

#### 2. 🛸 Dedicated Project Flow Stage (`ProjectFlowStage.tsx`)
- **Task Flow Matrix (The Anti-Kanban Invention)**: An interactive visual task dependency chain (`Step 1 ➔ Step 2 ➔ Step 3`) with step inspection and milestone controls.
- **Live Worker Agent Interaction Desk**: Dedicated turn-by-turn conversation feed with the project worker agent.
- **Interactive Graph Editor**: Append new steps (`＋ Add Step`) directly into the active flow matrix.
- **Integrated Diff & Approval Console**: Review proposed modifications and dispatch `Apply` / `Deny` decisions with live resume.

#### 3. 🌐 Web Search & Extract Tool Suite
- **`web.search`**: Real-time internet search with summarized snippets and clickable URL citations.
- **`web.extract`**: Agent-grade full-page extraction powered by Firecrawl API with resilient built-in fallback, converting cluttered web pages into clean GitHub Flavored Markdown.

#### 4. 🎨 Multimodal Image Generation
- **`image.generate`**: Text-to-image synthesis supporting FLUX, Stable Diffusion, and OpenAI DALL-E 3.
- **In-Chat Rendering**: Automatic rendering of generated artwork as interactive image preview cards in the desktop conversation stream.

#### 5. 🕹️ Headless Browser Automation Suite
- **`browser.navigate`**: Autonomous headless session navigation with structured DOM, link, and button parsing.
- **`browser.click` & `browser.type`**: Element interaction primitives for agent-driven workflows.
- **`browser.vision`**: Multimodal visual and structural page snapshots.

---

### 📦 Artifacts Included
- `iris-linux-x86_64-v0.2.1.tar.gz`: Standalone release binary bundle for Linux x86_64.
