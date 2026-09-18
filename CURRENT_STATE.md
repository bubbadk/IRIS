# IRIS Current State

Updated 2026-09-18. **Release version: 0.3.1.** Source, built binaries and published
releases are separate. The current tree is the **IRIS 0.3.1 release**: the 0.3.0 candidate — a large
body of post-0.2.11 work that passed the Phase 2J final adversarial release gate — plus the
platform-portability repairs that the hosted `Release` workflow proved mandatory before any platform
could build and sign. Phase 2K.1 applied the 0.3.0 version decision across all version metadata and
committed the candidate on `main`; Phase 2L tagged and pushed that commit as `v0.3.0`, and its `Release`
run then failed on all three platform workers. **`v0.3.0` is a source tag with no published release**,
and it was deliberately left in place rather than moved or deleted. Phase 2L.1 repairs the defects,
applies 0.3.1 across all version metadata, refreshes this documentation and `README.md`, and releases
the repaired build. Whether a release object exists for a tag is observable on the GitHub Releases
page; this file describes the source tree.

## Release gate status

**Phase 2J (post-2J.2) Final Adversarial Release Gate: PASS.** No open Critical or High finding
remains. Report: [PHASE-2J-POST-2J2-FINAL-RELEASE-GATE.md](.audit-release/PHASE-2J-POST-2J2-FINAL-RELEASE-GATE.md)
(local audit evidence, intentionally untracked like every other `.audit-*`/`.phase2*` directory).

Phase 2K prepared this tree for a release-candidate commit: reconciled this file, drafted release
notes, preserved the finding backlog, reviewed the release workflow and signing prerequisites, and
re-ran full verification. Phase 2K.1 then committed the candidate as a single atomic commit.
Neither phase pushed, tagged or published anything.

## Latest verified counts

Re-derived by the Phase 2J final gate, re-run after the Phase 2K documentation edits, and re-run on
hosted runners for the 0.3.1 platform repairs:

- **TypeScript** (`pnpm test`): **133 files / 1408 passed / 0 failed / 0 skipped / 0 todo**.
- **Rust, Linux** (`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`): **128 passed /
  0 failed / 13 ignored**. Twelve of the 13 ignored tests were additionally executed explicitly and
  passed; the thirteenth is a child-process fixture, not a standalone assertion.
- **Rust, macOS** (`macos-14` runner): **123 passed / 0 failed / 10 ignored**.
- **Rust, Windows** (`windows-latest` runner, `--lib`): **107 passed / 0 failed / 9 ignored**. The
  counts differ per platform because Unix-only cases run only where the platform supports them, and
  the Windows step is scoped to the lib target because the manifest that lets a Windows test binary
  load cannot be applied to a bin target in the same invocation. The bin and doc test targets contain
  no tests.
- `pnpm typecheck` and `pnpm lint` (`--max-warnings=0`): 0 errors, 0 warnings.
- `pnpm build` and `pnpm build:binary`: success. Isolated native boots: no panic, repository and
  scheduler initialise, no `PluginInitialization`.
- Controlled workers/adapters do not establish real model or external-service operation.

## Closed release-blocking findings

`F-1S` (native reader SSRF / canonical authority), `F-1H` (stale tool-ID compatibility), `F-2J2-SCH-01`
(provisional scheduler reservation release) and its `reconcile()` counterpart, `H1` (credential/origin
binding), `H2` (channel recovery), `H3` (secret temp file), `H4` (cancellation terminal truth),
`H5a` (reconcile authority), `H5b` (local reservation cleanup), `H6` (approval resume authority) and
channel fencing are all closed and were re-verified against the current tree. Detail remains in the
audit reports; user-facing context is summarised in the release notes draft.

## Surviving findings (post-release backlog; not release-blocking)

- **Medium F1** — CSV export falsely refuses valid content ending in a blank record
  (`apps/desktop/src/documentExport.ts`).
- **Medium F2** — the Documents UI keeps showing a stale error after a successful reload
  (`apps/desktop/src/DocumentsState.tsx`).
- **Medium F2C** — channel-attention state is durable but not surfaced in the app
  (`bridgeGateway.ts`, `ChannelsState.tsx`).
- **Low** — 18 reproduced historical Lows plus 3 static-only observations, one new `ProjectsState`
  reconcile availability observation (`F-2J3-1`), and the Tauri ACL observation (the app declares 67
  native commands but no application-level ACL entries; in-command runtime checks and a strict
  window CSP remain). Full technical detail is in the audit reports.

None of these was repaired in Phase 2K. They are recorded for a follow-up truthfulness pass, not for
this release.

## Implemented foundations and partial work

- **Product and architecture:** Local-first graphical agent environment with movable/resizable
  windows, named layouts, provider contracts, tools, skills, projects, schedules and inspectable
  context. Domain workflow logic stays independent of React/Tauri; UI and native adapters perform
  I/O. No fabricated runtime activity.
- **Project execution:** Acceptance criteria, bounded 1–10-turn runs and optional 1–1,440-minute
  deadlines; saved tool-result checkpoints, pause/manual resume, original provider/model retention,
  durable task queues and atomic claims. Interrupted side effects with unknown outcomes are not
  replayed automatically. Failed configured checks can trigger bounded repair. Natural reports require
  human review before dependencies unlock. Cross-process ownership uses real OS processes, a shared
  SQLite database and fail-closed reconciliation of live, dead and unknown owners.
- **Quality control (QC-1 / QC-2):** Every non-empty criterion line requires a saved human Met
  assessment with rationale/evidence. Reviews bind the task definition, exact criterion text,
  run/turn, worker report and configured artifact snapshot. Open blocking findings survive later runs
  until explicitly resolved. Acceptance re-reads targets and commits the receipt with task completion
  atomically in SQLite. Saved rejection reasons and bounded proposals are visible in both project
  surfaces. These are human observations and snapshot checks, not independent semantic verification or
  filesystem locks.
- **Storage and permissions:** SQLite repositories use revision-checked atomic commits; legacy
  localStorage is retained as migration backup. Failed persistence is reported. Mandatory
  shell/publication approvals remain enforced and cannot be bypassed through YOLO mode, an explicit
  allow rule, delegation, schedules, channels, resumed runs or legacy tool aliases. Execution claims
  prevent automatic replay after interruption.
- **Linux background runtime:** The System panel can install a per-user systemd unit launching the
  hidden graphical app with exclusive queue ownership. Live inspection found the service **not
  installed**. Full install/restart/crash/log/upgrade/removal lifecycle is unverified; removal ignores
  stop failures. No launchd/Windows service implementation.
- **Channels:** Telegram inbox polling, chat allowlisting and approve/deny routing to pending
  agent/project/schedule approvals exist with controlled-adapter tests. Polling is tied to the
  Channels window. Live remote identity/lifecycle remains unverified. Discord is an outgoing webhook
  sender only; automatic completion/failure notifications and reusable durable channel operation are
  missing.
- **Memory:** Ordinary memories have lexical/embedding/hybrid retrieval. Approved global/project
  knowledge has provenance, expiry, immutable revisions, atomic conflict replacement, project
  precedence and a conservative lexical related-entry signal that asks for human review. New turns
  select up to 20 active entries; the approved-knowledge tool can search up to 100 matching current
  entries when given a query. Semantic cross-topic contradiction handling remains missing. Retrieval
  coverage and final-answer benchmark accuracy are distinct.
- **Documents:** Durable Markdown/text/HTML/SVG/JSON/CSV revisions; agent create/read/list/revise
  tools; static previews; original-format and real DOCX, plain-text PDF, basic comma-separated-row
  XLSX and plain-text PPTX export with overwrite refusal. Rich editing, presentation
  themes/images/tables and comprehensive rendered-artifact validation remain missing.
- **Browser and workspace safety:** A separate visible Chrome session, screenshot view,
  permission-controlled address navigation, takeover, tab switching and stale-target refusal exist;
  discovery is Linux-specific. Embedded live view and persistent profiles are missing. The workspace
  shell defaults to probed offline Bubblewrap isolation on Linux with no silent host fallback. Text
  write/patch restore points enforce current-content checks; shell changes, moves/deletes and binaries
  have no automatic undo.
- **Onboarding:** The three-step wizard has a native workspace chooser, verifies a selected workspace
  rather than saving a fallback mount, and writes cloud provider keys to the credential store before
  the public provider configuration. Provider connectivity is not tested in the wizard; use Models to
  test it. Shared chat sessions retain streaming/approvals across views. Subtitle translation
  checkpoints support manual restart recovery. Telemetry absence is reported as unavailable. GitHub
  local scaffolding is distinct from publication.
- **Updater:** Readable target-version notes and signature/target/install-error checks are integrated.
  AppImage tooling handles Arch with `NO_STRIP`; the manual signing-required draft-release workflow
  attaches per-platform SHA-256 manifests. Historical signed-install/tamper/rollback evidence is not
  verification of this session's binary. Local `dist-release/latest.json` is stale unsigned 0.2.10;
  current public release state was not checked online.

## Debt, blockers and next work

- **Release version: 0.3.1 — repairs applied, synchronized and prepared for publication.** The explicit
  user version decision is applied and synchronized across the workspace manifests, `tauri.conf.json`,
  `Cargo.toml`, `Cargo.lock` and this file. `v0.3.0` remains a source tag with no published release.
  Publication (tag, signed build, GitHub release) still requires a fresh, explicit human approval for
  that exact invocation.
- An unintended partial QC-3 expansion was removed from active source and preserved separately in
  `/mnt/ai/IRIS-deferred/QC3-2026-09-12-z290fbrp`. It is unfinished and is not accepted evidence.
- Independent semantic review and permission-gated test-command execution (QC-3) remain missing.
  QC-2 proposes bounded task repairs; automatic project replanning is not implemented. See
  [IRIS_GAP_PLAN.md](docs/IRIS_GAP_PLAN.md) for every remaining requirement; all eight areas remain
  in scope.
- Repository-wide formatting still fails in other files; edited TypeScript/Markdown is formatted.
  Existing build chunk-size warnings remain. Ignored native integration tests require dedicated live
  fixtures.
- Onboarding does not validate provider connections or save entered secrets through the credential
  store during setup; unified account/channel/profile/security onboarding remains partial.
- macOS/Windows target machines, production updater signing keys and fresh explicit publication
  approval are external prerequisites. The 0.3.0 commit is published as the `v0.3.0` source tag with
  no release object; `v0.3.1` carries the platform repairs and is the version this tree releases.
