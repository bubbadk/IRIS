# IRIS Current State

Status: **IRIS v0.2.2 (Release with Clean Linter, Polished Types & Project Flow Reactor)**

- **Version**: `v0.2.2`
- **Project Flow Stream (HUD Live Section)**: Real-time dynamic project monitor in the right sidebar HUD under System Telemetry with progress indicators and inline `[ ✓ Apply ]` and `[ ✕ Deny ]` action buttons.
- **Project Flow Stage (`ProjectFlowStage.tsx`)**: Dedicated per-project living spatial window with interactive visual task chain / Flow Matrix (anti-Kanban), live worker agent conversation stream, and live permission approval dispatch.
- **Web Search & Full-Page Extract**: (`web.search`, `web.extract`) via Firecrawl and resilient search gateways.
- **Multimodal Image Generation**: (`image.generate`) with in-chat interactive preview cards (Flux, DALL-E, OpenRouter).
- **Headless Browser Automation Suite**: (`browser.navigate`, `browser.click`, `browser.type`, `browser.vision`) for agent driving primitives.
- **Full GitHub Operating Environment**: Integrated into left dock and window system (`GitHubState.tsx`).
- **Validation**: 100% green across 37 test suites (191 tests), 26 Rust tests, ESLint, strict TypeScript, and production binary build.

## Working foundation

- pnpm monorepo structure.
- React 19 + TypeScript desktop frontend.
- Tauri 2 native shell configuration.
- Linux desktop startup keeps hardware DMA-BUF transport on non-NVIDIA X11 and uses shared-memory transport with NVIDIA or Wayland.
- Native AppImage and release binary compilation.
- Model agnostic provider layer with OpenRouter, Anthropic, OpenAI, Google Gemini, and Ollama.
- Zero-surprise permission gating and OS Keyring integration.
