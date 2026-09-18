# IRIS — Release-Blocking Finding Closure Summary

Release-facing summary of the release-blocking findings repaired before this release candidate.
Full technical detail, reproduction steps and raw evidence remain in the audit reports under
`.audit-validation/` and `.audit-release/`. Nothing here is a claim beyond what the Phase 2J final
adversarial release gate verified.

**Gate result: PASS — no open Critical or High finding.**

---

## Closed release blockers

| ID | Defect class | Status | Strongest current verification evidence |
| --- | --- | --- | --- |
| **F-1S** | Native public-web reader could be steered to a non-public destination through host-spelling / resolution tricks | **Fixed / closed** | `web_policy`, `web_read` and `browser_proxy` Rust suites, plus a **live** public-page reader test and a **live** enforcing-proxy test that forwards public HTTPS and blocks loopback and private redirects |
| **F-1H** | Stale/legacy tool identifiers could mismatch canonical tool authority | **Fixed / closed** | `toolIdCompatibility.test.ts` (22 tests), `onboardingDefaultTeam.test.tsx`, and a native boot using a legacy-tool-ID agent document; unknown IDs fail closed and a legacy allow rule cannot widen a delegated child |
| **F-2J2-SCH-01** | A provisional scheduler reservation was not released when the acquiring attempt threw, producing a false "already executing" state | **Fixed / closed** | The verbatim pre-fix reproduction now shows `orphan = undefined` on all three retries with truthful infrastructure errors; a gate-owned 11-case matrix plus the product A–H/R1/R2 matrix pass with exactly one release per throwing attempt |
| **F-2J2 reconcile counterpart** | The same reservation leak on the `reconcile()` path could leave a phantom owner | **Fixed / closed** | Gate reconcile matrix cases H1/H2 plus real multi-process `h5a`/`h5b` trials: `phantom: null`, foreign lease preserved, local reservation `null` after reconcile, no blocked retry, live authority protected |
| **H1** | Credential could be used against the wrong origin / provider boundary | **Fixed / closed** | `credentialPrecedence.test.ts` (15), `imageCredentialBoundary.test.ts` (9), `credentials.test.ts`, and a real OS keyring round-trip |
| **H2** | Channel recovery could lose or double-apply an approval-relevant message | **Fixed / closed** | `channelDurability` (25) + reproduction + `channelRecovery` (26), plus real-process `chan-live`/`chan-unknown` ×2 trials |
| **H3** | A privileged (sudo) helper could leave a group-readable secret artifact | **Fixed / closed** | Rust `sudo_secret_file_tests`: 10 passed / 0 failed (owner-only modes, umask widening refused, symlink and pre-existing-path refusal, force-kill cleanup) |
| **H4** | A cancelled run could still report or resume as if active | **Fixed / closed** | `projectExecutionRaces.test.ts` (14), `projectRuntime.test.ts` (7) and real-process `h4` ×2: cancelled stays cancelled after another process resumes |
| **H5a** | Startup reconciliation could reclaim authority from a live owner | **Fixed / closed** | `projectExecutionAuthority.test.ts` H5a×3 and real-process `h5a` (live: no recovery), `h5a-dead` (reclaimed, run `failed`), `h5a-unknown` (fail-closed, `acquired=false`) ×2 each |
| **H5b** | Local execution reservation was not cleaned up, or was cleaned up while a foreign lease existed | **Fixed / closed** | `projectExecutionAuthority.test.ts` H5b, real-process `h5b` ×2 (`LOCALreservationAfterReconcile=null`, foreign lease preserved, null after restart) and mutation check M6 |
| **H6** | A pending approval could be executed by resuming a run instead of deciding it | **Fixed / closed** | `projectExecutionAuthority.test.ts` H6×3, `scheduledApprovalLifecycle.test.ts` (13), `remoteApprovalIdempotency.test.ts`, and real-process `appr` ×2: 0 entries into resume/execute/continue, run stays `suspended` |
| **Channel fencing** | Two processes could both act on the same channel occurrence during takeover | **Fixed / closed** | Real-process `fence` ×2: `B exit=0, entries=1, A_alive_at_takeover=yes` |

## Authority invariants re-verified (not separate IDs)

- Mandatory approvals (`janitor.command`) hold under YOLO mode, an explicit allow rule, an explicit
  deny, delegation to a child agent, scheduled runs, channel/remote approval, resumed runs, process
  recovery, concurrent execution and legacy tool aliases.
- Mutation sensitivity: 6/6 representative failures were re-introduced and **all were caught**; every
  mutated file was restored byte-identically and the post-mutation product manifest matched.
- All nine previously repaired Highs and both F-1 findings were re-verified against the current tree
  with current probes — **no regression**.

## What this summary does not claim

MacOS and Windows execution, live Telegram/Discord delivery, production-signed updater installation
and the published release workflow have **not** been verified. Three Medium findings and the
historical Low backlog remain open and are documented separately; none is release-blocking.
