# IRIS v0.3.0

IRIS v0.3.0 is a substantial capability release: cross-process execution authority, durable project
and schedule queues, documents, human-approved durable knowledge, a visible browser session and
default workspace isolation — all verified by the Phase 2J final adversarial release gate, which
returned **PASS** with no open Critical or High finding.

> **Status: release candidate, not yet published.** This tree is committed as the 0.3.0 release
> candidate. Tagging, signed builds and publication are a separate, explicitly authorised phase; no
> release has been published from it.

---

## Highlights

- **Execution authority is now cross-process.** Scheduler and project execution ownership is bound to
  real operating-system process identity over shared storage, and a live, dead or unknown owner is
  resolved distinctly. Unknown liveness fails **closed** rather than guessing.
- **Approval integrity is enforced at the authority path, not the UI.** Mandatory approvals cannot be
  bypassed through YOLO autonomy, an explicit allow rule, delegation to a child agent, scheduled runs,
  channel/remote approvals, resumed runs, process recovery, concurrent execution or legacy tool
  aliases.
- **Documents, knowledge and the visible browser are connected features.** Durable document revisions
  with real DOCX/PDF/XLSX/PPTX export, human-approved durable knowledge with provenance and atomic
  conflict replacement, and a real visible Chrome session with take-control handover.
- **Workspace execution is isolated by default on Linux** using Bubblewrap with no silent host
  fallback, plus content-checked file restore points.
- **The release gate passed.** 133 TypeScript test files / 1408 tests and 128 native tests pass; see
  [Verification](#verification).

## Agents and Execution

- Project and schedule execution claims are persisted **before** any side effect. A stopped run whose
  external outcome is unknown is never replayed automatically; the user inspects and re-queues it.
- Provisional scheduler reservations are released on every failure path — including the throwing
  acquire path — so a failed attempt reports the truthful infrastructure error instead of a false
  "already executing" state. Retry works without an application restart, and cleanup happens exactly
  once.
- Cancellation reaches a truthful terminal state, and resuming an approval does not execute the
  pending action.
- Legacy agent documents that reference old tool IDs resolve to canonical identities; unknown IDs fail
  closed, and a legacy allow rule cannot widen a delegated child's authority.
- **Verified:** dedicated authority, race, overlap and cross-process suites; six mutation-sensitivity
  checks confirmed the guarantees are actually tested.
- **Limited:** real model and external-service behaviour is not established by controlled
  workers/adapters.

## Projects and Scheduling

- A durable project task queue with atomic `queued → claimed` transitions; claimed work interrupted by
  shutdown becomes `needs-attention` rather than being replayed.
- A durable schedule queue with exclusive OS file-lock ownership, transactional occurrence claims,
  persistent pause/resume, and per-occurrence retention of the original prompt and agent.
- Acceptance criteria with saved human Met assessments, blocking findings that survive later runs, and
  bounded repair proposals.
- Fresh-evidence acceptance: completion re-reads every configured target and rejects changed, deleted,
  empty or unavailable evidence — even content that still passes a weak predicate — then commits the
  acceptance receipt and dependency completion atomically.
- Bounded 1–10-turn runs, optional 1–1,440-minute deadlines, saved tool-result checkpoints and manual
  resume.
- **Limited:** no independent semantic quality evaluator, no permission-gated test-command execution
  and no automatic replanning. These remain post-release work.

## Browser and Web

- A separate **visible** Chrome/Chromium session with a real captured screenshot (explicitly labelled
  as a screenshot, not live video), take-control handover, and stale-target refusal.
- Native public-web reads and an enforcing browser proxy: public HTTPS is allowed while loopback and
  private-network destinations are blocked, including via redirects. Host canonicalisation and
  DNS/address pinning prevent spelling and resolution bypasses.
- **Limited:** Linux browser discovery requires a compatible ChromeDriver; persistent profiles and an
  embedded live view are not implemented.

## Knowledge and Memory

- Human-approved global and project knowledge with topic, provenance, optional expiry, immutable
  revisions, project precedence and atomic conflict replacement that archives the previous active
  entry.
- New turns select up to 20 active, unexpired entries, preferences first; the approved-knowledge tool
  can search up to 100 current matching entries when given a query.
- Ordinary memories support lexical, embedding and hybrid retrieval.
- **Limited:** matching is deterministic by scope, kind and normalised topic, plus an explicit
  previous-entry identity, with a conservative lexical related-entry review signal. Semantic
  cross-topic contradiction detection is **not** implemented. Knowledge is contextual data and never
  grants execution permission.

## Documents

- Durable Markdown, text, HTML, SVG, JSON and CSV documents with author/turn-attributed revisions,
  revision-checked writes and bounded retention (256 KiB per revision, 50 revisions per document).
- Agent `create`/`read`/`list`/`revise` tools under the existing permission policy.
- Export in the original format and as real DOCX archives with headings, bullets and code font;
  plain-text PDF; basic comma-separated-row XLSX; and plain-text PPTX. Native export uses a save
  dialog and create-only writes that refuse to replace existing files.
- HTML/SVG previews render in a sandboxed iframe with script and same-origin access removed.
- **Limited:** rich presentation layout, themes, images and tables are not implemented, and Markdown
  constructs beyond headings/bullets/code remain literal in DOCX. A successful export is not a claim
  that another application will render it identically.

## Security and Reliability

- `shell.exec` defaults to **offline Bubblewrap isolation** on Linux (separate user, mount, process,
  IPC and network namespaces; capabilities dropped; environment cleared). A failed capability probe
  fails closed with no host fallback. Explicit host mode remains available and both modes retain
  mandatory per-invocation approval, including under YOLO autonomy.
- Content-checked workspace restore points for native text write/patch, with stale-file, wrong-workspace
  and symlink rejection.
- Credential handling is bound to origin and scope: native credentials use the OS keyring, browser
  credentials are session-only, and image-generation credentials respect provider boundaries.
- Privileged secrets are staged through private temporary files and removed afterwards.
- The main window runs under a strict CSP with `object-src 'none'`, `base-uri 'none'` and
  `form-action 'none'`; no remote content is loaded into the privileged window.
- Persistence is revision-checked and atomic; corrupted or malformed durable data fails safely and is
  reported rather than silently overwritten.
- **Observation (not release-blocking):** the application declares 67 native commands but no
  application-level Tauri ACL entries; those commands rely on in-command runtime checks plus the
  window CSP. This is recorded for a future hardening pass.

## Desktop / Native Runtime

- A per-user Linux systemd background runtime with exclusive queue ownership.
- The updater shows readable, target-version release notes and refuses missing summaries, changed
  target versions, unsigned metadata and installation failures.
- The manual draft-release workflow requires a production signing key, builds Linux, macOS-universal
  and Windows artifacts, generates one SHA-256 manifest per platform and uploads them to a **draft**
  release. Publishing remains a separate manual step.
- `pnpm build:appimage` handles Arch/CachyOS `.relr.dyn` library sections by retaining dependency
  symbols instead of invoking linuxdeploy's obsolete strip tool.
- **Limited / not verified externally:** the Linux background service lifecycle, macOS and Windows
  packaging and the production updater lifecycle. No production-signed asset exists yet.

## Compatibility

- **Source version:** 0.3.0. This is a committed release candidate; it is not tagged or published.
- **Verified locally on Linux** (CachyOS/Arch family): TypeScript and Rust suites, typecheck, lint,
  build, binary build and isolated native boots.
- **Declared but not verified here:** macOS (universal) and Windows packages. Their build targets
  exist in the release workflow; no target machine was exercised.
- **Runtime prerequisites for specific features:** Chrome + a compatible ChromeDriver (visible
  browser), Bubblewrap with unprivileged user namespaces (sandboxed shell), and a reachable OS
  credential store (native credential storage).
- **Browser preview** uses `localStorage` and does not execute queued work, schedules or native
  operations.

## Known Limitations

Three Medium findings and the historical Low backlog remain open by explicit release policy; none is
release-blocking. They are preserved for a post-release truthfulness pass and were **not** repaired in
this release:

- **F1 (Medium):** CSV export can falsely refuse valid content ending in a blank record.
- **F2 (Medium):** the Documents UI can keep showing a stale error after a successful reload.
- **F2C (Medium):** channel-attention state is durable but not surfaced in the application UI.
- **Low backlog:** 18 reproduced historical Low findings, 3 static-only observations, one new
  `ProjectsState` reconcile availability observation and the Tauri ACL observation above. Technical
  detail remains in the audit reports under `.audit-validation/` and `.audit-release/`.

Other known limits:

- macOS and Windows execution is unverified; no launchd or Windows service implementation exists.
- Telegram/Discord channel operation is verified with controlled adapters only; live remote identity
  and delivery are unverified, and Discord is an outgoing webhook sender only.
- Repository-wide formatting still reports unformatted files, and existing build chunk-size advisories
  remain.
- No production signing key, release endpoint or publish action was used during preparation.

## Verification

Phase 2J post-2J.2 final adversarial release gate result: **PASS** — no open Critical or High finding.

| Suite | Files | Passed | Failed | Skipped | Todo | Ignored |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript (`pnpm test`) | 133 | 1408 | 0 | 0 | 0 | — |
| Rust (`cargo test`) | — | 128 | 0 | — | — | 13 |
| Rust ignored, executed explicitly | — | 12 | 0 | — | — | 1 child fixture |

- `pnpm typecheck` — 0 type errors.
- `pnpm lint` (`--max-warnings=0`) — 0 errors, 0 warnings.
- `pnpm build` and `pnpm build:binary` — success.
- Native startup — isolated boots with no panic, repository and scheduler initialisation and SQLite
  integrity `ok`.
- Release-gate extras: live browser tests, a live enforcing-proxy test, a live native-reader test,
  Bubblewrap isolation tests, an OS keyring round-trip, a signed-updater fixture, 11 isolated native
  boots and 6/6 mutation-sensitivity checks.

Full evidence and exact counts are recorded in
`.audit-release/PHASE-2J-POST-2J2-FINAL-RELEASE-GATE.md` and the Phase 2K release-preparation report.

## Not yet published

This tree is committed as the IRIS 0.3.0 release candidate (Phase 2K.1). **No tag, push, published
release or release-workflow invocation has been performed.** The remaining steps — tagging `v0.3.0`,
building and signing the platform artifacts, and publishing the GitHub release with `latest.json` —
belong to a separate phase that requires a fresh, explicit human approval for that exact invocation.
