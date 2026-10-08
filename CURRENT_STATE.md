# IRIS Current State

Updated 2026-10-08. **Latest published release: v0.3.4.** GitHub release `v0.3.4` is marked Latest and points to commit `0fc6b8e6a88083ae572483c4c86363edc810914f` (merged PR #11). The manual Release workflow run [#25](https://github.com/bubbadk/IRIS/actions/runs/37762389070) completed successfully on Linux, macOS and Windows. It ran TypeScript and Rust checks, built signed installers/updater packages, and uploaded `latest.json` plus SHA-256 checksums.

The public updater manifest reports version `0.3.4`; all listed Linux, Windows and macOS targets have signed package URLs. The updater public key remains configured in `apps/desktop/src-tauri/tauri.conf.json`.

## Release highlights

- Project tasks can require an approved, isolated test command whose successful result is required before applying the task.
- Opt-in Telegram and Discord project status notifications send generic status only.
- Legacy provider credentials migrate to the OS credential store when retention is verified; provider errors redact credentials.
- Document exports handle XML-invalid characters and preserve Markdown headings and code fences in PowerPoint output.
- Project loading reports recoverable errors; browser DNS lookups use bounded workers and deadlines.

## Verification and limits

Release workflow #25 passed `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the native Rust suite on its hosted Linux, macOS and Windows runners. Signed release assets were produced for all three platforms. Hosted runner success does not establish installer or runtime behavior on end-user machines; Linux CachyOS/Arch remains the primary verified desktop environment.

Project test commands still require explicit approval. Project status notifications default to off; disconnected channels cannot deliver them, and Discord has no inbound listener.
