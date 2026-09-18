# Project result checks

Unreleased local work, version 0.2.11, 2026-09-09.

## Connected behavior

Projects → task form → **Automatic result checks** accepts up to eight checks. Choose a unique IRIS document title or a relative text-file path in the mounted workspace, then non-empty text, exact case-sensitive text, or valid JSON. File checks retain the canonical workspace root selected when configured. The run snapshots these definitions; changed checks invalidate launch reservation, continuation, resume and human verification.

After a natural final worker report, the workflow runtime reads the actual saved targets through a separate checker. Related assertions use one content snapshot. It persists each check round with the worker turn, time, outcome and document revision or file-content SHA-256. It does not accept the model's completion claim as check evidence.

A failed assertion or absent target triggers a corrective turn using the saved agent checkpoint and specific failure feedback, within the existing 1–10 turn budget. Tool-limit turns share this budget. A checker error, exhausted budget or unavailable continuation stops the task for attention. Tool permissions remain unchanged. Check failures support the same safe pause and manual resume as other continuations. Recovery can repeat read-only checks; it does not automatically replay agent actions.

Passing configured checks leads to human review. Dependencies unlock only after the existing explicit review operation. History shows earlier failed rounds, the latest result and snapshot evidence. Later edits can change the artifact. As of QC-1 (2026-09-10), final acceptance re-reads configured targets and rejects changed/missing evidence; see [project-acceptance.md](project-acceptance.md). The reviewer must still inspect current content.

## Verification

- Pure workflow tests exercise actual-content predicates, shared snapshots, malformed configuration, missing targets, checker errors, failed → corrected → review, budget exhaustion, refusal to complete failed/stale checks and pause/restart with remaining turns.
- Adapter tests read real document revision structures, reject duplicate titles and truncated files, and check a known SHA-256 digest. Workspace tests require both the frontend mount and native root to match the configured check.
- A native test reads temporary files and checks missing nested targets, root mismatch, traversal, symbolic links and the 1 MiB read limit.
- An isolated browser profile exercises the actual Projects form, saves a check, runs the real workflow and document repositories with an explicitly labelled offline test executor, persists failed and passing rounds across reload, and completes through the real human-review UI. No model or external service was called.
- The rebuilt release binary is checked with two native boots and retained data in a disposable profile.

## Limits

These predicates do not establish factual accuracy, comprehensive software correctness or visual quality. JSON checking validates syntax, not a schema. File checks read full UTF-8 text up to 1 MiB; symbolic links and truncated reads are refused. Duplicate document titles require disambiguation. A previously existing artifact may satisfy a check; creation by this run is not asserted. File hashes describe the read snapshot, not a lock against later external edits. No shell command, generated code or test suite is executed by the checker. Checks are configured when adding a task; existing tasks can be recreated with checks. Autonomous restructuring of the task graph is not implemented.
