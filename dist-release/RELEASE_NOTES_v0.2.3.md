## IRIS v0.2.3 — Native 1-Click Auto-Updater & Flow Reactor

IRIS v0.2.3 introduces native 1-click in-app auto-updates, along with the full Project Flow Reactor, Web Search & Extraction, Multimodal Image Generation, and Headless Browser Automation.

---

### ⚡ What's New in v0.2.3

#### 1. ⚡ Native 1-Click In-App Auto-Updater
- **Direct in-app downloading**: Users can click **"⚡ 1-Click Update"** right inside the app.
- **Real-time Progress Indicator**: Live download progress bar with downloaded percentage and megabytes.
- **Automatic Relaunch**: Installs the new binary package and relaunches IRIS automatically.

#### 2. 🔴 Live Project Flow Stream (HUD Live Section)
- **Live Project Status Pulse**: Integrated into the right desktop HUD sidebar directly beneath telemetry.
- **Real-Time Task Monitoring**: Displays live task milestone states (`● Working`, `● Awaiting Decision`, `● Ready`, `✓ Done`).
- **Inline Permission Approvals**: Direct **`[ ✓ Apply ]`** and **`[ ✕ Deny ]`** action buttons rendered on the project card.

#### 3. 🛸 Dedicated Project Flow Stage (`ProjectFlowStage.tsx`)
- **Task Flow Matrix (The Anti-Kanban Invention)**: Interactive visual task dependency chain (`Step 1 ➔ Step 2 ➔ Step 3`).
- **Live Worker Agent Interaction Desk**: Dedicated turn-by-turn conversation feed with the project worker agent.
- **Dynamic Step Creator**: Add new steps on the fly into active project graphs.

#### 4. 🌐 Web Search & Full-Page Extract Tool Suite
- **`web.search`**: Real-time internet search with summarized snippets and clickable URL citations.
- **`web.extract`**: Agent-grade full-page extraction powered by Firecrawl API with resilient built-in fallback.

#### 5. 🎨 Multimodal Image Generation
- **`image.generate`**: Text-to-image synthesis supporting FLUX, Stable Diffusion, and OpenAI DALL-E 3 with in-chat preview cards.

#### 6. 🕹️ Headless Browser Automation Suite
- **`browser.navigate`**, **`browser.click`**, **`browser.type`**, **`browser.vision`**: Headless browser driving primitives.

---

### 📦 Artifacts Included
- `iris-linux-x86_64-v0.2.3.tar.gz`: Standalone release binary bundle for Linux x86_64.
- `latest.json`: Auto-updater manifest.
