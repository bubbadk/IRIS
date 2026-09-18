# IRIS v0.3.2

IRIS v0.3.2 is a repair release. It fixes three truthfulness defects in the 0.3.x capability set —
cross-process execution authority, durable project and schedule queues, documents, human-approved
durable knowledge, a visible browser session and default workspace isolation — and changes nothing
else. It also carries the platform-portability repairs that let the native test suite build and run on
Linux, macOS and Windows.

> **Status: `v0.3.2` is a source tag, and this text is the release body prepared for it.** A
> downloadable release exists only once one is attached to `v0.3.2` on the GitHub Releases page; it is
> produced by the manual draft-release workflow, which requires a production signing key and refuses
> to build without one. `v0.3.0` and `v0.3.1` are source tags with **no** published releases. No tag
> was moved or deleted.

---

## What changed in 0.3.2

- **A valid CSV document is no longer refused.** CSV export writes each record terminated by CRLF; the
  previous writer never terminated the final record, so a document whose last record was blank — the
  two records `[["a"], [""]]` from `"a\n\n"` — serialized to `"a\r\n"`, reparsed as `[["a"]]`, and the
  export completeness gate refused it with "The CSV export is incomplete and has not been saved."
  The document was valid, nothing had been lost, and the message told the user otherwise. Export now
  round-trips the record structure and the gate passes, so the refusal is unreachable for parseable
  content. Reachable from **Export CSV** for `csv` and `text` documents.
- **The Documents window stops showing an error it has already disproved.** After a failed read, a
  successful reload replaced the document list and cleared the "could not be read" state but left the
  error text in place, so the window displayed the real document list, the empty-state invitation and
  "Saved documents are invalid. Existing data has been retained." simultaneously — denying data it was
  showing. The alert now remembers whether it came from a load or from an action: a successful reload
  clears the load error it supersedes and never erases a refused save or export the user has not read.
- **Channel updates that IRIS could not apply are visible in the app.** An update dropped on the
  restart-recovery path is classified once — the effect outcome could not be determined, the effect
  never started and its replay budget was spent, or the effect completed but its acknowledgement was
  not confirmed — and the record is retained. Nothing read it: the status banner only ever rendered a
  per-poll error, and a poll returns a bare `completed` result for an update it did not touch, so an
  update dropped before a restart was durable and invisible everywhere in the UI. The Channels window
  now loads the retained records whenever it opens — independently of whether polling is configured —
  and refreshes them after every poll, and it keeps showing them until they are resolved rather than
  offering to dismiss them.
- **Version metadata.** 0.3.2 is applied atomically across all 14 package manifests, `tauri.conf.json`,
  `Cargo.toml` and the derived `Cargo.lock` entry, together with `README.md` and `CURRENT_STATE.md`.
- **No other product behaviour was changed.** No feature was added, no unrelated defect was repaired
  and no permission, scheduler, network or sandbox behaviour was touched.

## Highlights

- **Execution authority is cross-process.** Scheduler and project execution ownership is bound to real
  operating-system process identity over shared storage, and a live, dead or unknown owner is resolved
  distinctly. Unknown liveness fails **closed** rather than guessing.
- **Approval integrity is enforced at the authority path, not the UI.** Mandatory approvals cannot be
  bypassed through YOLO autonomy, an explicit allow rule, delegation to a child agent, scheduled runs,
  channels, resumed runs, process recovery or legacy tool aliases.
- **Durable projects and scheduling.** Atomic task-queue transitions, exclusive OS file-lock schedule
  ownership, persistent pause/resume, bounded runs, saved checkpoints and acceptance receipts that
  re-read every configured target before committing.
- **Documents, knowledge and the visible browser.** Durable attributed documents with native export,
  human-approved durable knowledge, and a visible browser session with screenshot and DOM tools under
  the same permission policy.
- **Local-first security.** Offline Bubblewrap isolation for shell execution, origin-bound credentials,
  a strict window CSP, and revision-checked atomic persistence that fails safely instead of silently
  overwriting.
- **Desktop integration.** A per-user Linux background runtime, saved window layouts, and an in-app
  updater that shows readable, target-version release notes and refuses missing summaries, changed
  targets and unsigned metadata.

## Compatibility

- **Source version:** 0.3.2, tagged `v0.3.2`. The `v0.3.0` and `v0.3.1` tags carry no published
  releases.
- **Verified locally on Linux** (CachyOS/Arch family): TypeScript and Rust suites, typecheck, lint,
  build, binary build and isolated native boots.
- **Verified in the release workflow on macOS and Windows runners:** the native Rust test suite builds
  and passes on both. No end-user machine was exercised and no installer was launched there.
- **Runtime prerequisites for specific features:** Chrome plus a compatible ChromeDriver (visible
  browser), Bubblewrap with unprivileged user namespaces (sandboxed shell), and a reachable OS
  credential store (native credential storage and updater signature checks).
- **Browser preview** uses `localStorage` and does not execute queued work, schedules or native
  operations.

## Known Limitations

IRIS states its gaps as plainly as its capabilities. Current product-scope limits:

- macOS and Windows are covered by the native test suite on hosted CI runners, but no end-user machine
  was exercised and no installer was launched there; there is no launchd or Windows service
  implementation.
- Telegram and Discord channel operation is verified with controlled adapters only — live remote
  identity and delivery are unverified, and Discord is an outgoing webhook sender only.
- Channel updates IRIS could not apply are recorded and listed in the Channels window, but they cannot
  be resolved from inside the application.
- The Linux background runtime installs a per-user systemd unit, but its full
  install/restart/crash/upgrade/removal lifecycle is unverified.
- Workspace restore points cover native text write/patch only; shell changes, moves/deletes and
  binaries have no automatic undo.
- There is no independent semantic quality evaluator and no automatic project replanning; acceptance
  uses saved human assessments plus configured-evidence checks.
- In-app updating requires an asset signed with the matching production key; the release workflow
  refuses to build a release without it.

## Verification

| Suite | Files | Passed | Failed | Skipped | Todo | Ignored |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript (`pnpm test`) | 134 | 1416 | 0 | 0 | 0 | — |
| Rust, Linux CachyOS `cargo test` (local) | — | 128 | 0 | — | — | 13 |
| Rust, `macos-14` runner `cargo test` | — | 123 | 0 | — | — | 10 |
| Rust, `windows-latest` runner `cargo test --lib` | — | 107 | 0 | — | — | 9 |

Each of the three repairs is pinned by a regression test that fails against the previous code: the
CSV cases that were previously refused now export and reparse to the same records, the Documents test
reloads a failed store successfully and asserts the error is gone, and the channel test opens the
window with a retained record and asserts it is shown and cannot be dismissed.

Platform-gated tests are the reason the Rust totals differ: Unix-only cases (process liveness via
`kill(pid, 0)`, device-and-inode directory identity, `umask`, `flock`, symlink substitution) run only
where the platform can support them. The Windows step runs `--lib` because the manifest that lets a
Windows test binary load cannot be applied per-target to a bin in the same invocation; the bin and doc
test targets contain no tests, so no assertion is lost.

- `pnpm typecheck` — 0 type errors.
- `pnpm lint` (`--max-warnings=0`) — 0 errors, 0 warnings.
- `pnpm build` and `pnpm build:binary` — success.
- Native startup — isolated boots with no panic, repository and scheduler initialisation and SQLite
  integrity `ok`.

## Publication

Release `v0.3.2` is produced by the manual draft-release workflow, which requires a production signing
key and refuses to build without one. Tagging, building, signing and publishing are performed under a
fresh, explicit human approval for that exact invocation, and the draft is reviewed before it is
published.
