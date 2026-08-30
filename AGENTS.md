# IRIS Development Rules

IRIS means **Intelligent Reasoning & Integration System**.

## Product truth

IRIS is a graphical agent operating environment, not a chatbot with a dashboard attached.
The UI is object-oriented, spatial and desktop-like. The visual reference in
`docs/design/iris-concept-board.png` is authoritative for the overall feel.

## Non-negotiable design direction

- Bright, warm, premium surfaces.
- Spacious layouts and strong typography.
- Floating, movable, resizable objects and windows.
- Calm state communication instead of noisy dashboards.
- No dark cyberpunk theme, neon AI clichés, dense admin grids or fake terminals.
- No fake runtime data. Empty state is better than simulated functionality.

## Architecture rules

- UI must not own agent execution logic.
- Model providers implement shared provider contracts.
- Agent configuration is separate from agent runtime.
- Permissions must gate execution-capable tools.
- Memory, tools, providers and orchestration stay replaceable behind interfaces.
- Local-first must remain possible. Cloud services are optional integrations.
- Keep domain packages free of React and Tauri dependencies.

## Development rules

- Build real vertical slices. Do not create fake feature demos.
- Add tests for meaningful behavior.
- Keep TypeScript strict.
- Keep the application runnable after each meaningful change.
- Do not silently change the product vision to fit a generic component library.
- AppImage is a required Linux release artifact.
- CachyOS/Arch is a first-class development target.

## Context discipline

Before major work read:

1. `AGENTS.md`
2. `CURRENT_STATE.md`
3. `docs/PRODUCT_VISION.md`
4. only the source files relevant to the work being performed

Keep `CURRENT_STATE.md` short and factual.
