# Contributing to IRIS

Thank you for your interest in contributing to **IRIS (Intelligent Reasoning & Integration System)**!

## Architectural Principles

Before submitting code, please review our core architectural rules:

1. **Local-First**: All core functionality must remain fully functional without mandatory cloud accounts.
2. **Strict UI Isolation**: The React/Tauri frontend does not own agent execution loops or domain business logic.
3. **Safety by Default**: Execution-capable tools and file system modifications must be permission-gated with verifiable diffs.
4. **Strict TypeScript & 100% Passing Tests**: All PRs must pass `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `cargo test`.
5. **No Simulated Data**: Features must be backed by real runtime capabilities. Empty states are preferable to fake metrics.

## Development Workflow

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/your-username/iris.git
   cd iris
   pnpm install
   ```

2. Start the development desktop app:
   ```bash
   pnpm desktop
   ```

3. Run verification before creating a Pull Request:
   ```bash
   pnpm -r typecheck
   pnpm -r lint
   pnpm test
   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
   ```

4. Create a descriptive pull request explaining your changes.
