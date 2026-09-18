# Project execution verification

Local working-tree implementation, 2026-09-07. Release version remains 0.2.11; no publication performed.

## Available behavior

- Both Projects and Flow Reactor accept observable acceptance criteria and a maximum of 1–10 agent turns. New tasks default to 4; old tasks without a setting retain 1.
- A tool-limit boundary continues within the same run and remaining turn budget. A natural final response goes to human review. Neither a model success claim nor a runtime limit completes the task.
- Pause takes effect at a completed turn boundary. Pending permission requests must still be resolved. Resume restores the saved tool results and original provider/model, with the remaining budget.
- Completed turn checkpoints persist locally. Startup leaves recoverable work paused until the user resumes it. Missing checkpoints, mismatched later turns, and interrupted actions with unknown outcomes cannot be automatically replayed.
- A review note is required to complete a worker task. Native storage commits task completion and verification together, and arbitrates competing review, launch and resume operations.
- Explicit continuation starts a new run and budget, using the prior report and available checkpoint context. After interruption, the worker is instructed to inspect current external state.

## Verification performed

- `pnpm typecheck`: passed.
- `pnpm lint`: passed, zero errors and warnings.
- `pnpm test`: 554 passed across 64 suites.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 46 passed; 2 existing tests ignored.
- `pnpm build:binary`: passed. The release binary used by the local `iris` command was rebuilt.
- `python scripts/verify-native-startup.py`: two successful native boots with SQLite initialization/integrity checks and saved memory retained across restart. Disposable profiles were used.
- Required updater public key verified unchanged.
- Browser review checked both project surfaces, persisted criteria, turn-limit fields, disabled launch without an agent, and form layout. Component tests cover explicit review, error display and pause while a resumed worker is running.
- Runtime tests cover bounded continuation, approval/restart counters, saved tool results without reexecution, paused recovery, missing/stale checkpoint refusal and competing native resume claims.

## Limits of this verification

Providers and tool results in automated runtime tests are controlled test implementations. No live model request was made. Project execution does not establish autonomous acceptance verification or a service that keeps executing after IRIS closes. The separate shell isolation and file restore implementation is documented in [workspace-safety.md](workspace-safety.md). A checkpoint is a saved conversation/tool-result boundary, not a snapshot of external side effects.
