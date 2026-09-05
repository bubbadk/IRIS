# IRIS v0.2.11

IRIS v0.2.11 improves data durability, chat continuity and tool approvals, and adds tested Linux update packaging.

- Store native repository data in SQLite with atomic revision checks, retry on competing writes and a one-time migration that preserves the original localStorage data.
- Keep streaming chat and pending approvals across Agent, Desklet and GitHub view changes. Preserve consecutive approvals and prevent duplicate execution of an approved invocation.
- Show real activity across native windows, display unavailable telemetry honestly and store channel credentials in the OS keyring.
- Resume partial subtitle sessions after restart; save named desktop layouts and keep restored windows inside the viewport.
- Show readable release summaries and reject changed update targets or unsigned packages. Build AppImages on Arch/CachyOS and require signing credentials for the manual release workflow.
- Split large UI components, bound retained command output and load memory benchmark data only when requested.

Verification: 530 TypeScript tests, 46 ordinary native tests, isolated real keyring and signed AppImage integration tests, clean typecheck/lint, and native boot/restart with preserved data.

Known limits: Telegram/Discord support outgoing tests only; live delivery awaits a configured recipient. Workspace commands are permission-gated, not an OS sandbox. Signed updater tests used disposable local keys; source publication alone does not provide a production-signed update. macOS/Windows installers and cross-distribution Linux portability have not been verified by this local run.
