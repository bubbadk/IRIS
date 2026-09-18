# Fresh evidence at project acceptance

QC-1, verified 2026-09-10 on Linux. Source version remains 0.2.11; these are local, unreleased changes on top of the existing working tree.

## Problem and behavior

Previously, a project worker could produce a passing check report, then its document or workspace file could change before the user clicked **Verify & complete task**. Completion consulted the saved report only.

Verification now reads every configured target again through the existing read-only result checker. Missing content, failed predicates, unavailable reads, missing evidence and changed document revision/file SHA-256 all reject completion. Even changed content that still passes a weak nonempty/contains predicate requires inspection and a new run with new evidence. The existing **Continue task** action obtains that evidence; clicking Verify itself never launches a worker, executes a command, calls a model or modifies a deliverable.

The UI submits the visible run snapshot. The runtime checks it before reads and sends an internal receipt to the existing repository committer. The committer compares the expected run inside the same transaction that saves human verification and dependency completion, preventing a concurrent run change or a transaction retry from applying obsolete review evidence. The fresh report must name the same worker turn, contain the complete ordered check set, have a valid timestamp between the recorded checks and human acceptance, pass every check, and retain identical nonempty evidence.

Accepted runs retain `verification.checkReport` alongside the original worker check rounds and the human review note. The UI explicitly shows when acceptance checks ran. Hydration validates this report and cloning isolates its nested evidence. Previously completed runs without this field remain readable; no new verification is attributed to them. Checkless tasks still require explicit human review and do not gain automatic quality claims.

## Verification performed

- `pnpm typecheck`: passed.
- `pnpm lint`: passed, zero warnings/errors.
- `pnpm test`: **626 passed across 82 suites**. New checks cover changed-but-still-passing content, deletions, empty targets, unavailable reads, absent evidence/receipts, wrong worker turns/timestamps, stale UI and concurrent run changes, immutable receipts and successful unchanged acceptance. Existing tests still cover failed → repair → review and permission/restart boundaries.
- The desktop reader integration test creates an actual temporary file, reads its real bytes through the production SHA-256 adapter, rewrites it with still-passing content, then deletes it. Changed and absent content block acceptance. Its filesystem reader is a fixture, so native path enforcement remains covered separately by Rust tests.
- Repository transaction tests exercise acceptance with and without configured checks: disk failure leaves the task unfinished, competing reviewers have one winner, dependencies and receipt commit together, and a reopened repository retains the report. The backend for these concurrency tests is controlled, not a claim of a separate database engine test.
- A real Chromium session used the actual Projects form, document repositories, workflow runtime, completion committer and review UI on an isolated local origin. A labelled offline worker produced failed then passing rounds. The saved document was then revised while still satisfying its contains check: Verify displayed the rejection and retained the unfinished task. A fresh offline continuation checked revision 3; explicit UI review completed it and the receipt survived page reload. No provider or remote service was called. Screenshots were inspected for layout.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: **57 passed, 5 ignored**. Ignored tests require live browser, unlocked keyring, Bubblewrap or signed updater fixtures; none is counted as a pass.
- `pnpm build:binary`: passed; the local `iris` launcher resolves to the rebuilt release executable. Existing large JavaScript chunk warnings remain.
- `python scripts/verify-native-startup.py /home/bubbadk/.local/bin/iris`: **two successful native boots**, no panic, IPC-backed SQLite initialization/integrity, retained memory/documents/knowledge/paused queue and acceptance receipt. Uses disposable XDG directories. This tests retention of a labelled receipt fixture, while the browser smoke tests the actual review action.
- Required updater public key is unchanged. All inspected package/Tauri JSON versions remain 0.2.11.
- Targeted Prettier checks pass for edited TypeScript/Markdown files. **Repository-wide `pnpm format:check` fails in 122 other files**; mass-formatting unrelated existing work was not performed. No formatting/test gates were weakened.

## Limits and continuation

This closes the stale-snapshot acceptance hole for configured checks; it is not semantic review, a test runner, factual validation or proof that every requested feature exists. Files and documents can still change after the read; review is a snapshot, not a filesystem lock. A restored file with identical bytes has the same content hash; a new document revision deliberately requires new evidence even when its text is identical. Internal receipts are not cryptographic attestations against a compromised app process.

At the QC-1 milestone, rejected attempts displayed an error without a separate rejection history. [QC-2](project-quality-coverage.md), verified separately on 2026-09-11, now persists acceptance rejection reasons and human quality findings while keeping task completion blocked; it adds bounded repair proposals without automatically altering the project plan. Obtaining new evidence currently uses Continue and its explicit new worker budget. A future read-only review refresh could avoid that extra worker turn.

No macOS/Windows build or runtime was verified. No production signing, version bump, push, PR, tag, workflow invocation or publication occurred. See [IRIS_GAP_PLAN.md](../IRIS_GAP_PLAN.md) for all eight areas and the subsequent **QC-2 criterion coverage and persisted review findings** milestone (now completed locally; next: QC-3 permission-gated test execution).
