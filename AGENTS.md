# IRIS Development Rules

IRIS means **Intelligent Reasoning & Integration System**.

## 1. Product Truth & Core Philosophy

IRIS is a **graphical agent operating environment**, NOT a chatbot with a dashboard attached.
The UI is object-oriented, spatial, and desktop-like. The visual reference in
`docs/design/iris-concept-board.png` is authoritative for the overall aesthetic and feel.

### Non-negotiable design direction:
- **Bright, warm, premium surfaces** (ivory/beige/glass tones).
- **Spacious layouts and strong typography**.
- **Floating, movable, resizable objects and windows**.
- **Calm state communication** instead of noisy charts.
- **NO dark cyberpunk themes, neon AI clichés, dense admin grids, or fake terminals**.
- **NO fake runtime data**. Empty state is better than simulated functionality.
- **100% Truthfulness & Honesty (NON-NEGOTIABLE)**: NEVER lie, never simulate data with timers/setTimetout, and never claim a feature works if it does not. Always state technical realities, limitations, and errors directly, clearly, and immediately.
- **100% English UI**: All user-facing strings, presets, form labels, tool tips, error messages, and commit logs MUST strictly be in English.

---

## 2. Architecture & Layering Rules

- **UI Isolation**: UI components MUST NOT own agent execution logic. Domain packages remain pure TypeScript and free of React and Tauri dependencies.
- **Provider Layer**: Model providers implement shared provider contracts (`@iris/providers`).
- **Runtime vs Config**: Agent configuration is strictly separated from agent runtime.
- **Security & Permissions**: Execution-capable tools MUST be gated by zero-surprise permission policies (`[ ✓ Apply ]` / `[ ✕ Deny ]`).
- **Local-First Integrity**: Local-first operation is paramount. Cloud services (OpenRouter, Firecrawl, etc.) are optional integrations.
- **Strict TypeScript & ESLint**: Zero TypeScript errors (`tsc --noEmit`), zero linter warnings (`eslint --max-warnings=0`), and strict interfaces (avoid `any`).

---

## 3. Desktop Runtime & Build Environment (CRITICAL)

- **Development Platform**: CachyOS / Arch Linux is a primary tier-1 target, alongside standard Linux, macOS, and Windows.
- **Local Binary Setup**:
  - `~/.local/bin/iris` is symlinked to `/mnt/ai/IRIS/apps/desktop/src-tauri/target/release/iris`.
  - When building release binaries with `pnpm build:binary`, the binary at `apps/desktop/src-tauri/target/release/iris` is updated.
- **Tauri 2 Configuration Requirement**:
  - The Tauri Updater plugin (`tauri-plugin-updater`) REQUIRES the `pubkey` field inside `plugins.updater` in `apps/desktop/src-tauri/tauri.conf.json`.
  - NEVER remove or corrupt `pubkey`. If missing, the desktop application will panic with `PluginInitialization("updater", "missing field pubkey")` and fail to boot.
  - The official public key is:
    `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc2NTI2MTcxOTE3ODYwN0IKUldSN1lIaVJjV0ZTZG80SGVacXNSNUpyNU9xU3N6YnFlakZaRzdXeTh3VmFPaGkzN0lzZkhtVFoK`
- **Application Runnability**: The desktop app MUST remain runnable after every single meaningful change. Always test that `iris` boots without panic.

---

## 4. Release & Versioning Policy (CRITICAL USER RULE)

- **NO Unrequested Git Pushes**: NEVER push commits or tags to GitHub (`git push`) unless the user explicitly requests a release or version bump.
- **Atomic SemVer Bumping**:
  When the user requests a new release (e.g. `v0.2.4`):
  1. Bump version string across ALL 13 package files simultaneously:
     - `package.json` (root)
     - `apps/desktop/package.json`
     - `apps/desktop/src-tauri/tauri.conf.json`
     - `apps/desktop/src-tauri/Cargo.toml`
     - All 9 packages: `packages/{agents,core,cortex,github,mcp,memory,skills,tools,workflows,workspaces}/package.json`
     - `CURRENT_STATE.md`
  2. Refresh `README.md` so nothing stale ships: version badge, the "Key Features in vX.Y.Z" section (headline features of THIS release; older features collapse into a summary), download filenames in Quickstart, and any capability claims the release changed (e.g. tool availability). No section may describe a feature as missing or removed if it now exists, or vice versa.
  3. Rebuild the release binary: `pnpm build:binary`.
  4. Package tarball: `tar -czf dist-release/iris-linux-x86_64-vX.Y.Z.tar.gz -C apps/desktop/src-tauri/target/release iris`.
  5. Generate updater manifest: `dist-release/latest.json` containing the new version and asset download URL.
  6. Commit with message `chore(release): bump version to vX.Y.Z`, tag `vX.Y.Z`, push `main` and `vX.Y.Z`.
  7. Publish release on GitHub with `latest.json` and the `.tar.gz` binary bundle attached.

### Updater release-note disclosure (NON-NEGOTIABLE)

- Before an in-app update can be installed, the updater MUST show a concise, human-readable summary
  of what changes in that exact version. Users must be able to understand what they are updating to
  without leaving IRIS.
- The summary must be sourced from the published release notes, rendered as readable text (not raw
  Markdown), and name the target version. A full changelog/GitHub link may supplement the summary,
  but can never replace it.
- Every release therefore needs concrete, user-facing release notes. Do not publish a release whose
  updater view contains only a version number, a generic message, or a compare URL.

### GitHub publication approval wall

- An agent must never create a pull request, trigger a GitHub Actions workflow, or create a
  GitHub release without a fresh, explicit human approval for that exact invocation.
- This rule applies even when an agent runs in YOLO mode or has an allow rule. Do not weaken,
  remove, or bypass the corresponding mandatory approval checks.
- The workspace shell is mandatory-approval as well, so it cannot be used to sidestep this wall
  with `gh`, `git push`, or other publication commands.
- SemVer selection, changelog/release-note authoring, release assets, tags, and CI build outputs
  are publication-sensitive material. A model recommendation is not approval to publish it.

---

## 5. Core Feature Suites & Reference Implementations

1. **Project Flow Reactor (`ProjectFlowStage.tsx`, `SystemPanel.tsx`)**:
   - The spatial "Anti-Kanban" invention.
   - Real-time project pulse stream in the right HUD under machine telemetry.
   - Visual dependency matrix (`Step 1 ➔ Step 2 ➔ Step 3`) with inline `[ ✓ Apply ]` / `[ ✕ Deny ]` tool permission gates and worker chat feed.
2. **FP-AMB Memory Engine (`packages/memory`, `MemoryBenchmarkView.tsx`)**:
   - Measured **69.7% accuracy** on the 221 automatically gradeable questions of the official FP-AMB suite (154/221; 41 refusal/judgment questions are excluded from automated scoring because they require semantic/agent-in-the-loop grading). Real corpus: 60 sessions, 739 turns, ~819k indexed tokens.
   - Multi-tier BM25 lexical + semantic vector embedding + temporal chrono-resolution (session distance math & relative date deltas).
   - In-app interactive benchmark dashboard in the Memory window with real-time verification exam runner. No benchmark numbers are displayed before a real run.
3. **1-Click In-App Auto-Updater (`UpdateNotificationModal.tsx`, `updateChecker.ts`)**:
   - Integrated with `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`.
   - Real-time GitHub release polling from `bubbadk/IRIS`.
   - In-app download progress indicator with automatic restart upon completion.
4. **Agent Tool Suites (`packages/tools`)**:
   - `web.search` & `web.extract` (Firecrawl integration with markdown cleanup).
   - `image.generate` (Flux / DALL-E 3 with in-chat preview rendering).
   - `browser.*` (Headless browser navigation, element clicking, typing, and visual snapshots).
5. **GitHub Operating Environment (`GitHubState.tsx`, `packages/github`)**:
   - Repository inspector, issue triage, automated changelog generation, and project scaffolding.

---

## 6. Verification Checklist Before Finishing Any Task

Before completing any task or starting a session:
1. `pnpm typecheck` must pass with 0 errors across all 12 packages.
2. `pnpm lint` must pass with 0 errors and 0 warnings (`eslint src --max-warnings=0`).
3. `pnpm test` (Vitest) must pass 100% (all 37+ test suites).
4. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` must pass all 26+ native tests.
5. Verify `apps/desktop/src-tauri/tauri.conf.json` retains the required `pubkey` for updater initialization.
6. Keep `CURRENT_STATE.md` short, factual, and strictly synchronized with the current release version.
