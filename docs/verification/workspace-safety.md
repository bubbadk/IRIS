# Workspace isolation and file restore verification

Local implementation verified on 2026-09-08. Version remains 0.2.11; no publication performed.

## Shell execution

`shell.exec` defaults to `isolation: workspace`. Linux uses Bubblewrap with separate user, mount, process, IPC and network namespaces, further user namespaces disabled, capabilities dropped, a new session and parent-death handling. Only the mounted workspace, read-only system tools/libraries, private temporary directories and namespace-local `/proc` and `/dev` are exposed. The command starts at `/workspace`; inherited environment variables are cleared.

The native capability probe must succeed before an isolated invocation. Missing Bubblewrap, unavailable namespaces and unsupported platforms fail without a host fallback. Explicit `isolation: host` preserves the existing unrestricted command mode. Both modes retain mandatory per-invocation approval, including under YOLO autonomy. Workspace reports the real probe result.

This isolates shell execution, not every tool or IRIS itself. Anything inside the mounted workspace remains accessible, including credentials or sockets that a user placed there. System tools must be installed under the exposed system paths; home-installed tools and package caches are not mounted. The isolated network is offline. This is not a VM, a resource quota, or a snapshot of the workspace.

The policy follows the upstream [Bubblewrap security model](https://github.com/containers/bubblewrap#sandbox-security) and [command documentation](https://man.archlinux.org/man/bwrap.1.en). Its effectiveness was checked with actual processes, not inferred solely from arguments.

## File restore points

Native workspace write and patch commands save a durable original UTF-8 file snapshot before editing, up to 1 MiB. A create operation records that the original file did not exist. Snapshot files are flushed, atomically named and stored outside the workspace in the app data directory; Unix snapshot directories/files use private permissions. Storage failure prevents the edit.

Workspace lists the latest 50 restore points for the mounted canonical folder. A point's status is computed from current file contents: matching the saved edit, matching the original, changed, or unavailable. The original and expected current text can be previewed before an explicit Restore action. Native code checks exact current contents again and rejects stale files, a different workspace and symbolic links. Restoring a new file removes it only if its contents still match the saved edit.

The native edit lock serializes IRIS file writes, moves, deletion and restore operations. External editors and host commands do not participate in that lock and can still race filesystem operations. This is content-checked undo, not a transactional filesystem. Shell changes, moves, deletion, binary files and historical edits have no automatic restore points. Restore changes file contents/existence, not arbitrary external side effects or filesystem metadata.

## Validation

- TypeScript typecheck and lint: passed with zero errors/warnings.
- Full TypeScript suite: 559 tests across 65 suites passed, including project continuation and recovery.
- Standard Rust suite: 52 tests passed. Four environment-dependent tests are excluded from the default run; the two new Linux integration tests were explicitly run and passed. Two older environment-dependent tests remain unrun.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml live_ -- --ignored`: both real Linux integration tests passed. They cover workspace writes, denial of host files and symlink escapes, cleared environment, hidden host processes, read-only system files, host-network denial, the actual IRIS shell runner and timeout with retained partial output.
- Native restore tests cover existing and newly created files, whole-file restoration after a snippet patch, refusal of newer content, wrong-workspace identities, symlink substitution and storage failure before mutation.
- UI component tests cover preview-before-restore, stale-file errors and disabled restore for conflicts. A separate clearly labelled browser fixture was used for visual review and then removed.
- Release binary rebuilt; two native boots passed with repository initialization, integrity checks and retained memory. Required updater public key unchanged.

No live model requests or production file changes were used for these checks. Real process/filesystem tests used disposable directories and desktop startup used isolated profiles.
