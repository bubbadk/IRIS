# Local hardening verification — 2026-09-05

The detailed hardening checks below were performed on the v0.2.10 development build and are included in source version **v0.2.11**. The v0.2.11 build also passed typecheck, lint, all 530 TypeScript tests and 46 ordinary native tests. Publishing source commits/tags is separate from publishing a signed binary release.

## Completed

- Native repository storage now uses `repositories.sqlite3` in the app-local data directory. Each call reads a scoped snapshot; a SQLite transaction verifies every read revision before applying all writes. Competing calls retry the repository operation, never external tool execution.
- Startup imports the active origin's repository keys once, atomically. Invalid JSON aborts migration. Existing localStorage is retained as a backup; tombstones prevent deleted records from returning on a later launch. Browser preview, credentials, UI preferences and subtitle checkpoints retain their separate stores.
- Agent, Desklet and GitHub chat views share a session controller. Runtime state survives view changes; consecutive approvals remain visible and duplicate tool names are resolved by invocation ID. Editor controls, tool traces, shared chat content, GitHub service state and dialogs have separate modules.
- GitHub chat exposes Apply/Deny. Repository load failures are visible. Scaffolding errors stop project creation; generated files are accurately described as local. Release notes cannot be invented from generic binary claims.
- Channel keyring identifiers now satisfy native validation. An isolated real OS keyring write/read/delete succeeded; it used only a disposable dummy credential.
- Unsigned updater metadata is rejected before download, with a readable explanation.

## Verification

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm test`: 530 tests in 62 suites passed.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 46 passed; the opt-in keyring test was separately run with `--ignored` and passed (47 native tests exercised total).
- `pnpm build:binary`: passed. The existing lazy benchmark-data chunk still produces a build-size advisory.
- `python scripts/verify-native-startup.py`: two native boots without panic; database initialization through native IPC and integrity checks passed; an isolated stored memory record survived restart.
- Browser UI smoke check: agent editor and channel window rendered; submitting an empty agent showed the expected validation error.
- Real BroadcastChannel tests cover snapshot request, project worker start/completion, malformed messages and cleanup.
- Updater public key remained exactly unchanged.

## Signed updater verification (completed locally)

`python scripts/verify-signed-updater.py --appimage apps/desktop/src-tauri/target/release/bundle/appimage/IRIS_0.2.10_amd64.AppImage` passed using the real Tauri updater plugin, real HTTP downloads on loopback, a real locally built AppImage, and disposable signing keys. Only the Tauri application handle uses its test runtime. The installed AppImage was then launched as a real process, restarted, and checked for retained data.

- Correctly signed package: downloaded and installed successfully; resulting bytes exactly matched the input AppImage.
- Tampered package: rejected by cryptographic signature verification; the original executable stayed intact.
- Signed tarball with an unsupported member name: installation failed and restored the old executable.
- The installed AppImage booted twice, initialized the database through native IPC, and retained its stored test memory.
- Production signing key, updater endpoint, version and published release remained unchanged. Test private keys were deleted with the temporary directory.
- `scripts/build-appimage.mjs` uses linuxdeploy's `NO_STRIP` option to avoid its obsolete strip tool failing on Arch/CachyOS `.relr.dyn` sections. `pnpm build:appimage` now builds successfully on this host. This does not establish cross-distribution portability.
- The manual draft-release workflow now requires `TAURI_SIGNING_PRIVATE_KEY`, passes its optional password, selects the desktop project and enables updater artifacts through `tauri.updater.conf.json`. The existing approval guard is retained. No workflow was triggered; production secret availability has not been verified.

Machine-readable results: `signed-updater-result.json`. The additional updater test is opt-in; the full native count is now 46 ordinary tests plus the keyring and updater integration tests.

## Remaining external inputs

- Real Telegram/Discord delivery cannot be verified yet: the inspected IRIS configuration has no Telegram chat IDs and no Discord connection. The user has been asked to select a test recipient and configure the credential in IRIS. No messages have been sent and no delivery is claimed.
- The existing local `dist-release/latest.json` is still the unsigned v0.2.10 manifest. Local integration tests are complete; production update distribution requires a separately approved, correctly signed release using the matching production key. This task has not requested or performed publication.
- Browser cross-window serialization depends on Web Locks support. Native repository integrity uses SQLite and does not depend on Web Locks.
