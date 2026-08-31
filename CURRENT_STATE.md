# IRIS Current State

Status: **IRIS v0.2.0 (with Web Search, Image Gen & Headless Browser Automation Suite)**

- Web Search & Full-Page Extract (`web.search`, `web.extract`) via Firecrawl and resilient search gateways.
- Multimodal Image Generation tool (`image.generate`) with in-chat interactive preview cards (Flux, DALL-E, OpenRouter).
- Headless Browser Automation suite (`browser.navigate`, `browser.click`, `browser.type`, `browser.vision`) for agent driving primitives.
- Full GitHub Operating Environment integrated into left dock and window system (`GitHubState.tsx`).
- New `@iris/github` domain package with GitHub REST service, SemVer bumping, changelog generators, and automated release pipeline dispatch.
- New `github` Agent Autonomy profile with standard tool suite (`github.list_repos`, `github.get_repo`, `github.create_repo`, `github.create_release`, `github.trigger_workflow`, `github.get_workflow_status`, `github.list_issues`, `github.create_pull_request`).
- Multi-step "New Project Walkthrough" guide from local workspace development to initial push and live automated versioning.
- Public GitHub release `v0.2.0` published with production binary bundle.
- Repository validation is 100% green: 37 test suites (191 tests), 26 Rust tests, ESLint, strict TypeScript, and production binary build.
- Spatial Glass Capsule HUD Desklet fully implemented with live status pulse, specialist activity feed, and system telemetry.
- In-app update notification modal and 3-step onboarding wizard with automatic existing-data detection.

## Working foundation

- pnpm monorepo structure.
- React 19 + TypeScript desktop frontend.
- Tauri 2 native shell configuration.
- Linux desktop startup keeps hardware DMA-BUF transport on non-NVIDIA X11 and uses shared-memory transport with NVIDIA or Wayland.
- Native AppImage and release binary compilation.
- Model agnostic provider layer with OpenRouter, Anthropic, OpenAI, Google Gemini, and Ollama.
- Zero-surprise permission gating and OS Keyring integration.
