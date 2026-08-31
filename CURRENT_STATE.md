# IRIS Current State

Status: **IRIS v0.2.0 (with Live Project Flow Stream & Project Flow Reactor Stage)**

- **Project Flow Stream (HUD Live Section)**: Real-time dynamic project monitor situated in the right sidebar HUD under System Telemetry. Displays live progress pills, active task execution pulses, and inline `[ ✓ Apply ]` and `[ ✕ Deny ]` approval buttons.
- **Project Flow Stage (`ProjectFlowStage.tsx`)**: Dedicated per-project living spatial window/popup. Provides an interactive visual task chain / Flow Matrix (not Kanban), live worker agent conversation stream, task prerequisite editing, and live permission approval dispatch.
- **Web Search & Full-Page Extract**: (`web.search`, `web.extract`) via Firecrawl and resilient search gateways.
- **Multimodal Image Generation**: (`image.generate`) with in-chat interactive preview cards (Flux, DALL-E, OpenRouter).
- **Headless Browser Automation suite**: (`browser.navigate`, `browser.click`, `browser.type`, `browser.vision`) for agent driving primitives.
- **Full GitHub Operating Environment**: Integrated into left dock and window system (`GitHubState.tsx`).
- **New `@iris/github` domain package**: GitHub REST service, SemVer bumping, changelog generators, and automated release pipeline dispatch.
- **GitHub Agent Autonomy profile**: Standard tool suite (`github.list_repos`, `github.get_repo`, `github.create_repo`, `github.create_release`, `github.trigger_workflow`, `github.get_workflow_status`, `github.list_issues`, `github.create_pull_request`).
- **Validation**: 100% green across 37 test suites (191 tests), 26 Rust tests, ESLint, strict TypeScript, and production binary build.

## Working foundation

- pnpm monorepo structure.
- React 19 + TypeScript desktop frontend.
- Tauri 2 native shell configuration.
- Linux desktop startup keeps hardware DMA-BUF transport on non-NVIDIA X11 and uses shared-memory transport with NVIDIA or Wayland.
- Native AppImage and release binary compilation.
- Model agnostic provider layer with OpenRouter, Anthropic, OpenAI, Google Gemini, and Ollama.
- Zero-surprise permission gating and OS Keyring integration.
