# Explicit criterion coverage and persistent quality findings

QC-2, verified locally on Linux on 2026-09-12 (fresh continuation checks). Source version remains **0.2.11**. Existing local changes were preserved. No version bump, push, tag, PR, workflow invocation or publication was performed.

## Behavior and architecture

The existing task criteria field remains the source of truth: **each non-empty line is a required criterion**. One paragraph on one line remains one criterion; the implementation does not pretend to understand or split prose semantically. Duplicate lines retain separate positions. The exact original text is saved as the criterion version, so edits and reordering invalidate the binding.

The shared project review component, used by Projects and Project Flow, now offers **Not yet verified**, **Met** and **Not met**, plus rationale and evidence for each criterion. An assessed outcome requires both rationale and evidence. Omitted criteria remain unverified. Saving a review does not complete the task. The final human confirmation, review note and Verify action remain required.

`packages/workflows/src/qualityReview.ts` contains pure TypeScript domain logic. Reviews bind project/task/run IDs, the worker turn/output/check report, the exact criteria, and the task title/instructions/check configuration. The review UI displays the task title/instructions and submits their captured version. A task edit after opening the form rejects saving before artifact reads; a concurrent edit during reads rejects the transaction. The runtime re-reads configured document/file targets when saving a review. A changed artifact snapshot cannot supply current coverage. Final acceptance still performs QC-1's fresh read and unchanged-evidence validation inside the completion transaction.

Runs store append-only `qualityReviews` and `qualityRejections`. Reviews contain assessments, blocking/advisory findings with concrete repair text, and explicit finding resolutions with explanations. Findings are gathered across all runs of the same task; launching a new run does not erase them or inherit criterion approval. Finding resolutions involving configured artifacts require fresh unchanged check evidence. Only explicit current human coverage plus no open blocking findings can pass final acceptance. Manual completion cannot bypass criteria/checks by omitting a run.

The existing SQLite transaction adapter compares the reviewed run and task snapshot again at commit. Concurrent reviews, changed task definitions and new runs reject obsolete submissions. Native acceptance persists the receipt and dependency completion atomically. Rejected acceptance returns an error as transaction data so its reason can be committed before the runtime reports failure. A disk failure is reported rather than claimed as a saved rejection. Historical metadata cannot be overwritten by a later ordinary run save; invalid quality-bearing records fail closed instead of disappearing from the repository. The former 250-run eviction was removed to preserve findings and history.

The **Bounded repair proposal** lists at most eight concrete findings/missing criteria/rejection items, with limited text per item and an explicit notice when items remain. It is a proposal for the same task, not an automatic plan edit. The user starts the existing continuation with its configured fresh turn/time budget, previous report and available checkpoint/tool history. No actions are replayed during review, and no permissions are granted by a finding or resolution. Changes to the source review while the worker is being prepared reject the reservation. Worker execution, pause/resume and unknown-side-effect safeguards remain in the existing runtime.

Legacy tasks and completed runs remain readable without fabricated coverage, findings or evidence. New approval of an unfinished task with explicit criteria requires actual human assessments, including for tasks without automatic text checks.

## Verification performed

- Fresh baseline typecheck, lint, TypeScript tests and native Rust tests were run before implementation; prior verification notes were not used as proof.
- Final `pnpm typecheck`: passed.
- Final `pnpm lint`: passed with zero warnings/errors.
- Final `pnpm test`: **653 tests passed across 84 suites**. New domain/runtime/UI/repository tests cover missing/unmet/unverified coverage, missing evidence, duplicates and malformed records, task/run/artifact staleness, simultaneous reviews, task-instruction edits before saving and during artifact reads, native transaction retries/disk failure, blocking/advisory findings, cross-run resolution, persistent rejection history, retention beyond the previous limit, bounded proposal content, fresh budgets and permission suspension/denial. Existing QC-1 unchanged-evidence, missing/deleted real-file, receipt, competing-acceptance and checkpoint tests pass.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: **57 passed, 5 ignored**. The ignored live-browser/keyring/isolation/signed-updater integration tests remain ignored and are not counted as passes.
- `pnpm build:binary`: passed; `/home/bubbadk/.local/bin/iris` resolves to the rebuilt `apps/desktop/src-tauri/target/release/iris`. Existing large JavaScript chunk warnings remain.
- `scripts/verify-project-quality.mjs` passed against the real local Vite app in an isolated Chromium profile. It creates a labelled **controlled offline worker**, uses the production workflow runtime, actual document repositories/checker, Projects review UI and completion committer, and does not call a model. The journey first changes task instructions while the form is open and verifies that saving is rejected without creating a review; after refresh it displays the new instructions. It then records unmet/met criteria, a concrete blocking finding, rejected acceptance and retained history after reload; clicks the saved repair proposal; records fresh coverage and an explicit resolution; edits the document again while its weak predicate still passes; verifies that QC-1 rejects it; then continues, re-reviews and explicitly accepts with fresh evidence. It records **three runs and two acceptance rejections**. The dependent task unlocks only after acceptance. A complete browser close/reopen retains the exact project/run records. Screenshots were inspected; fields, evidence, findings and rejection messages are visible in the existing warm project window.
- `scripts/verify-project-quality-native.py` passed with the actual records exported from that browser journey: **two native Linux boots without panic**, IPC-backed SQLite initialization/integrity, and byte-for-byte retained project, document, quality-review, resolution, rejection and acceptance records in a disposable XDG profile. The script inserts the exported records while IRIS is stopped; it verifies native startup/storage retention, not a second enactment of the review clicks in the native webview.
- The exact mandatory updater public key is retained. Inspected package/Tauri JSON versions remain **0.2.11**.
- Targeted Prettier checks and `git diff --check` pass for this milestone's changes. The new Python verification script is formatted with Black and passes syntax validation. Full `pnpm format:check` still fails in **118 other files**. Existing formatting debt was not hidden, mass-reformatted or excluded from checks.

The repository concurrency tests use a controlled transaction backend; native SQLite behavior is additionally covered by the Rust suite and the two-boot smoke. The controlled worker proves the application flow, not model quality, provider connectivity or independent semantic verification.

## Reproduction and local evidence

Start an isolated local development origin, then run the browser script with an installed Playwright module and Chrome executable:

```sh
pnpm --filter @iris/desktop dev --host 127.0.0.1 --port 5192
IRIS_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-project-quality.mjs
python scripts/verify-project-quality-native.py /home/bubbadk/.local/bin/iris /printed/browser-directory/records.json
```

`IRIS_SMOKE_URL` and `IRIS_CHROME` can override the local URL and executable. The browser script refuses non-local origins, creates a new disposable browser profile and prints its artifact directory. Finish the binary build before browser testing: Vite can reload the page when Tauri writes generated build assets.

This session's final browser artifacts are in `/tmp/iris-qc2-browser-SplDeW/`: screenshots and `records.json`. Native artifacts are in `/tmp/iris-qc2-native-gggpm7ox/`. Current command logs use `/tmp/iris-qc2-resumed-{typecheck,lint,tests,rust,build,full-format,browser,native}.log`. These are disposable local evidence, not release assets.

## Limits and next milestone

Human evidence text is an attributed observation, not independently validated semantic proof. Automatic artifact freshness covers only configured document/file targets; a manually cited unconfigured target cannot be re-read or freshness-checked by this milestone. Checkless reviews bind the run/task/report and the human's evidence statement. A report saying “done” and passing nonempty/contains/JSON predicates never create criterion approval automatically.

Artifact reads remain snapshots; files/documents can change after the read. Neither QC-1 nor QC-2 locks the external filesystem or offers cryptographic attestation against a compromised application process. Native SQLite is the supported atomic persistence path; the browser smoke uses the existing localStorage fallback, not a claim of cross-window SQLite semantics in Chromium. History is retained without automatic pruning; a future explicit retention policy must preserve unresolved findings and review provenance.

No independent semantic evaluator, test-command runner or automatic project replanner is included in the active QC-2 code. An unintended partial QC-3 expansion was identified during continuation, removed from active source, and preserved as an unfinished whole-file snapshot in `/mnt/ai/IRIS-deferred/QC3-2026-09-12-z290fbrp`. Its checks are not claimed as QC-2 verification; do not restore those whole files over later changes. No service/channel/browser/document/onboarding feature or target-platform release work was added here. Previously existing work in those areas remains in place, and all eight areas remain in the gap plan.

**Exact next milestone: QC-3 — permission-gated test execution.** Bind approved, bounded commands and real exit/output evidence to the task/run through existing isolation, budgets and safe checkpoints. Independent read-only semantic review through provider contracts follows as a separate milestone. Preserve explicit human acceptance.
