# IRIS Phase 2E — Document Integrity

Scope: fix the verified document-system audit findings **H-07**, **M-17**, **M-18**, **M-19** and
**M-20**. No provider fixes, no general UI refactor, no docs cleanup, no commit.

Repository HEAD is unchanged at `53e32b4356f6e0639ecb8435bb7b18176b7b4eb5`.

---

## 1. Initial State

| Property                                     | Value                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| HEAD                                         | `53e32b4` (`53e32b4356f6e0639ecb8435bb7b18176b7b4eb5`) |
| Tracked files modified before Phase 2E       | 91                                                     |
| Untracked files before Phase 2E              | 106                                                    |
| `git status --short` entries before Phase 2E | 197                                                    |
| Staged changes                               | none                                                   |
| Stash                                        | none                                                   |

The whole document system (storage, agent tools, export, UI) is uncommitted work from an earlier
phase, so those files are reported by Git as untracked. Git status alone therefore cannot show
Phase 2E content changes inside them; the recorded pre-fix behaviour is captured as executed-test
evidence instead (§3).

Baseline artifacts (gitignored scratch, never part of the tree):
`node_modules/.phase2e/{baseline.status,baseline.diffstat,baseline.head,baseline.tracked-changed,baseline.untracked,h07-before-fix.log}`.

Environment note: `pnpm` needs a writable XDG data directory, so every `pnpm` command below ran with
`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`/`XDG_CONFIG_HOME`/`XDG_RUNTIME_DIR` pointed inside
the workspace. No project configuration was changed to achieve this.

---

## 2. H-07 — PDF export silently truncated documents

### Reproduction, before any fix

`node_modules/.phase2e/h07-before-fix.log` records the failure **through the production export path**
(`exportDocument` → `pdfDocument`), not against a private helper:

```
× exports every line of a 200+ line document ... 24ms
  → expected 'Phase 2E integrity document\n\n# Long…' to contain 'MARKER-100 '
× reports the PDF as multi-page when the document needs more than one page
  → expected 1 to be greater than 1
```

The received document stops at `MARKER-39`. `MARKER-100` and `FINAL-LINE-MARKER` are absent, the PDF
contains exactly one page, and `exportDocument` **still resolved successfully** — the silent-success
half of H-07. The same run shows `æøå` rendered as `???`.

Root cause: the writer wrapped the text, then emitted only `lines.slice(0, 46)` — roughly one page of
content — with no page loop and no completeness check, while still reporting a successful export.

### Fix

`apps/desktop/src/documentExport.ts` now has a real layout and a real success contract:

- `paginatePdf()` measures every wrapped line with real Helvetica AFM advance widths, packs lines
  into pages of 44 baselines (US Letter 612×792, margins 72, body 11 pt/15 leading, title 16 pt/30
  leading, content width 468, top 720, bottom 72), and emits **one PDF page object per page** with a
  correct `/Count`.
- `pdfDocument()` asserts its own output before returning: the number of `) Tj` operators must equal
  the number of lines the layout planned, otherwise it throws
  `The PDF export is incomplete and has not been saved.` A partial PDF can therefore never be
  reported, and never written, as a success.
- Text is encoded as WinAnsi (Latin-1 plus the CP1252 specials). A character that WinAnsi cannot
  represent raises a controlled error naming the code point (`The PDF export supports Latin-1 … U+1F600`)
  instead of substituting `?`.
- The writer self-checks that the emitted byte stream is pure ASCII, so every xref offset above stays
  exact.

### Proof after the fix

- Every line of a 200+ line document survives; `MARKER-1`, `MARKER-100` and `FINAL-LINE-MARKER` are all
  present in the production export.
- A document that needs more than one page reports `pages > 1` and a matching `/Count`.
- First, middle and last markers land on the correct pages.
- A long wrapped paragraph keeps its final word (`TERMINAL-WORD`).
- A 4 000-character unbroken string is broken inside the column instead of dropped.
- `æøå` is emitted as `\346\370\345`; `U+1F600` and `U+0000` fail explicitly.
- An empty document is exactly one page containing the title.
- An extreme but allowed 262 144-byte document exports without truncation.

---

## 3. M-17 — Native export destination security

### The problem

The renderer held `dialog:allow-save`, so it could obtain an arbitrary absolute path, and
`save_document_export(path, data)` accepted that path directly. Any code running in the webview could
therefore write up to 12 MiB of attacker-chosen bytes to any absolute path with an allowed extension.
Other write paths in IRIS go through a confinement/provenance model; this one did not.

### The trusted-destination model

The path parameter no longer exists. Two commands replace it:

1. `begin_document_export(suggested_name, extension)` — runs in the backend, opens the **native Save
   dialog itself** (`tauri_plugin_dialog`), validates the chosen path, and records a
   `PendingExport { path, parent, parent_identity, extension, issued }` under an opaque token. It
   returns `{ token, path, extension }` or `null` when the user cancels.
2. `save_document_export(ticket, data)` — accepts **only** the opaque token plus base64 data.

`apps/desktop/src/documentExport.ts` calls `begin_document_export` and forwards only the returned
`ticket`, so the IPC surface carries no host path in either direction.

Enforced properties:

- **Issued capability only.** A path never enters through IPC; an unknown token is refused, and a
  capability can be redeemed exactly once (removed from the table before any filesystem work).
- **Short-lived.** Tickets expire after 120 s; expired entries are reclaimed on the next issue.
- **Bounded.** At most 16 tickets may await a file.
- **Absolute + extension-bound.** The extension must be one of
  `md, txt, html, svg, json, csv, docx, pdf, xlsx, pptx`, and the filename's extension must match the
  format the ticket was issued for.
- **Leaf-name-only suggestion.** `sanitize_suggested_name` strips separators, control characters and
  leading dots, so `../../etc/passwd` becomes `passwd.txt`.
- **Real directory, verified twice.** The parent is canonicalized at issue time and re-verified before
  the write. On Unix the directory's **device and inode** are also recorded and compared, so a
  directory swapped at the same path between approval and write is detected (a path comparison alone
  cannot see that). The check is repeated after the file is opened; a detected swap removes the file.
- **No symlink target.** A symlinked destination is refused, and `create_new` (O_CREAT|O_EXCL) refuses
  a link that appears in the final component.
- **Create-only.** An existing file is never overwritten; the user is told to choose a new filename.
- **Bounded payload.** 12 MiB ceiling on decoded bytes. Malformed base64 is refused without touching
  the filesystem.
- **No unconfirmed success.** If any write or `sync_all` step fails, the partial file is removed and
  the command returns an error.

Defense in depth on the capability set: `dialog:allow-save` was removed from
`apps/desktop/src-tauri/capabilities/default.json`. That file, and the regenerated
`gen/schemas/capabilities.json`, are now **byte-identical to HEAD** — the uncommitted document work had
broadened the renderer's capability, and Phase 2E restores the committed permission set. The app was
rebuilt and re-verified afterwards (§10), proving the removal is safe. `dialog:allow-open` is retained.

### Proof

Rust (`document_export.rs`, 14 tests) and TypeScript (`documentExportDestination.test.ts`, 4 tests):

| Attack / edge                                        | Result                                                 |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Write to an arbitrary absolute path                  | Impossible: no command parameter carries a path        |
| Never-issued or empty token                          | Refused; no file created                               |
| Replayed token                                       | Refused (single use); first payload intact             |
| Expired ticket                                       | Refused; no file created                               |
| Relative path (`report.txt`, `../report.txt`)        | Refused                                                |
| `exe`/`sh` extension, or extension/filename mismatch | Refused                                                |
| Relative-suggestion traversal (`../../etc/passwd`)   | Sanitized to `passwd.txt`                              |
| Symlink planted at the destination                   | Refused; the link target is untouched                  |
| Directory replaced after approval (TOCTOU)           | Refused; nothing written into the new directory        |
| Existing file at the destination                     | Refused; original bytes intact                         |
| Payload above 12 MiB                                 | Refused; no file created                               |
| Malformed base64                                     | Refused; filesystem untouched, capability still usable |
| > 16 pending tickets                                 | Refused; expired tickets are reclaimed                 |
| Renderer tries to open a save dialog itself          | `save()` is never called; asserted by test             |
| Renderer sends a path in any IPC call                | Asserted: recorded calls contain no host path          |
| User-selected destination                            | Succeeds and writes the real bytes                     |

---

## 4. M-18 — Format correctness

### CSV (`apps/desktop/src/csv.ts`, new)

- RFC 4180 `parseCsv`: quoted commas, doubled-quote escapes, CRLF, embedded newlines, and no
  manufactured trailing empty row for a trailing separator.
- `serializeCsv` quotes only when required and terminates records with CRLF.
- Generated CSV neutralizes spreadsheet formula injection: a leading `=`, `+`, `-`, `@`, TAB or CR is
  prefixed with an apostrophe, so a cell can never be interpreted as a formula.
- The byte-faithful **"Export original format"** path never rewrites the user's own bytes — the
  neutralization applies only to the opt-in generated CSV.

### XLSX

- Excel limits are enforced instead of producing an unopenable file: 1 048 576 rows, 16 384 columns,
  32 767 characters per cell.
- XML escaping and truncation happen in the correct order (escape the truncated text, never truncate
  the escaped text), so the 32 767-character boundary always yields well-formed XML.
- Every cell is `t="inlineStr"`, which is structurally immune to formula execution; the output is
  asserted to contain no `<f>` element.
- XML 1.0-hostile characters are replaced, and quoted newlines/tabs survive inside a single cell.
- The archive contains the required OOXML parts and relationships.

### PPTX

- Fixed an invalid `p:spTree`: it may contain only `p:nvGrpSpPr`, `p:grpSpPr`, then shapes. A stray
  `p:spPr` made the file schema-invalid.
- `presentation.xml.rels`, every slide part and `[Content_Types].xml` are consistent.
- The first and last slide markers remain readable.

### PDF guards

Beyond §2: the export refuses a conversion the source cannot faithfully represent, and refuses a
character WinAnsi cannot encode, rather than emitting an incomplete or lossy document.

### Conversion support (backend authority)

Frontend filtering is not treated as security: `exportDocument` asserts
`assertExportSupported` **first**, before any work, so a request that bypasses the UI is rejected by
the same code path the UI uses.

---

## 5. M-19 — Size semantics

The schema limit was measured in characters while domain validation ran in bytes, so the tool layer
and the domain disagreed about what fits.

- `packages/workspaces/src/documents.ts` is now byte-authoritative for content:
  `documentByteLimit = 262_144` **UTF-8 bytes**, with `utf8ByteLength()`; the error names both the
  limit and the actual byte count. `requireDocumentContent()` rejects lone surrogates and invalid JSON.
- The title limit is **code points** (`documentTitleLimit = 180`, `unicodeLength()`), so an emoji title
  is measured the way a human counts it, not in UTF-16 units. `documentFilename()` truncates at 100
  code points and never splits a surrogate pair.
- `documentTools.ts` runs the same authoritative validation at runtime for `documents.create` and
  `documents.revise`, and describes the limit precisely ("maximum 262144 UTF-8 bytes") while keeping a
  coarse JSON-Schema `maxLength`. JSON Schema cannot express a UTF-8 byte limit, so the schema is a
  fast pre-filter and the domain is the authority — the description says so rather than implying the
  schema is exact.
- `documents.revise` now reads the document first to learn its stored format before validating content.

Tests assert tool/domain accept–reject agreement across five encoding families (ASCII, Danish, emoji,
CJK, combining marks) at the limit and one over, in both directions.

---

## 6. M-20 — Storage and quota

- `LocalDocumentRepository(storage?, byteLimit = documentAggregateByteLimit, countLimit = documentCountLimit)`
  with `documentAggregateByteLimit = 8 MiB` and `documentCountLimit = 200`.
- Every write builds the whole next payload, measures it, and commits it through a **single**
  `writeStorageValue` call. A store that is already over budget may shrink but never grow further.
- `writeStorageValue()` captures the previous value, and if `setItem` throws (quota exceeded) it
  performs a best-effort rollback and rethrows a controlled `StorageQuotaExceededError` whose message
  states that nothing was saved. A failed save leaves the previous raw value byte-identical, so a
  failed write cannot leave corrupt JSON behind and cannot lose the current revision.
- `create` refuses past the document-count cap; `revise` keeps working.
- The budget is measured in UTF-8 bytes, matching M-19.

Documented trade-off: revisions are **not** auto-pruned, because `validateDocument` requires
`revision.number === index + 1`; pruning would force renumbering and falsify provenance. The sanctioned
fallback is the aggregate cap plus a controlled error ("data preservation over convenience"). Live
data above the cap is never destroyed: it is retained and can be shrunk, and new growth is refused
with an explanatory error.

---

## 7. Format Matrix

Destination × source. `✔` = supported and verified; `—` = refused by the backend.

| Source ↓ / Target → | source | Word (docx) | PDF | XLSX | PPTX | CSV |
| ------------------- | ------ | ----------- | --- | ---- | ---- | --- |
| markdown            | ✔      | ✔           | ✔   | —    | ✔    | —   |
| text                | ✔      | ✔           | ✔   | ✔    | ✔    | ✔   |
| html                | ✔      | —           | —   | —    | —    | —   |
| svg                 | ✔      | —           | —   | —    | —    | —   |
| json                | ✔      | —           | ✔   | —    | —    | —   |
| csv                 | ✔      | —           | ✔   | ✔    | —    | ✔   |

`source` is always supported and is byte-faithful: it writes exactly the stored revision bytes and is
the only path that never rewrites the user's document.

---

## 8. Export Validation Matrix

Every destination validates its own output before reporting success.

| Format | Validation performed before success is reported                                                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF    | Planned-line count equals emitted `) Tj` operator count; every referenced page exists; `/Count` matches the page tree; the byte stream is pure ASCII (so xref offsets are exact); unencodable code points raise a controlled error |
| DOCX   | Real OOXML archive with the required parts and relationships; headings, list definitions, Unicode and literal code survive                                                                                                         |
| XLSX   | Row/column/cell limits enforced; XML escaping happens after truncation; no `<f>` element; every cell `t="inlineStr"`; required parts and relationships present                                                                     |
| PPTX   | `p:spTree` contains only valid `CT_GroupShape` children; `presentation.xml.rels`, slide parts and `[Content_Types].xml` agree; first/last slide markers readable                                                                   |
| CSV    | Serialized output is re-parsed and compared with the parsed input (round-trip equality) **before** formula neutralization; CRLF records; no trailing empty row                                                                     |
| source | Output bytes equal the stored revision bytes                                                                                                                                                                                       |

Capability refusal happens before any work, so an unsupported source → target pair never produces
partial output.

---

## 9. Adversarial Matrix

| #   | Adversary / condition                              | Expected                                                               | Verified by     |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------- | --------------- |
| 1   | Renderer names an arbitrary absolute path          | Denied by construction (no path parameter)                             | Rust + TS tests |
| 2   | Renderer mints its own export token                | Denied (token must exist in the backend table)                         | Rust test       |
| 3   | Renderer replays a token                           | Denied (single use)                                                    | Rust test       |
| 4   | Renderer reuses an old token                       | Denied (120 s TTL)                                                     | Rust test       |
| 5   | Renderer floods the ticket table                   | Denied (> 16 pending; expired reclaimed)                               | Rust test       |
| 6   | Renderer suggests `../../etc/passwd`               | Sanitized to a leaf name + correct extension                           | Rust test       |
| 7   | Renderer requests an `exe`/`sh` destination        | Denied (extension allow-list)                                          | Rust test       |
| 8   | Filename extension disagrees with requested format | Denied                                                                 | Rust test       |
| 9   | Symlink planted at the destination                 | Denied; link target untouched                                          | Rust test       |
| 10  | Directory replaced between approval and write      | Denied (canonical path + device/inode identity)                        | Rust test       |
| 11  | File already exists at the destination             | Denied; original bytes intact                                          | Rust test       |
| 12  | Payload above 12 MiB                               | Denied; no file created                                                | Rust test       |
| 13  | Malformed base64 payload                           | Denied; filesystem untouched                                           | Rust test       |
| 14  | `U+1F600` / `U+0000` in a PDF                      | Controlled error naming the code point, never `?`                      | TS test         |
| 15  | 200+ line document (H-07)                          | Complete, multi-page PDF; every marker present                         | TS test         |
| 16  | Empty document                                     | Exactly one page, not zero                                             | TS test         |
| 17  | 262 144-byte document with no breaks               | Exported without truncation                                            | TS test         |
| 18  | `=cmd()` in a generated CSV cell                   | Neutralized with a leading apostrophe (generated CSV only)             | TS test         |
| 19  | `=cmd()` in XLSX                                   | Structurally impossible: `t="inlineStr"`, no `<f>`                     | TS test         |
| 20  | XML-hostile characters (`& < > " '`, controls)     | Escaped/replaced; output stays valid XML                               | TS test         |
| 21  | Escaping makes a boundary-length cell longer       | Still valid XML (escape after truncate)                                | TS test         |
| 22  | Quoted newline/tab inside a CSV cell               | Preserved inside one cell                                              | TS test         |
| 23  | Emoji title (180 code points / 360 UTF-16 units)   | Accepted; filename never splits a surrogate pair                       | TS test         |
| 24  | Content one byte over the limit (5 encodings)      | Denied identically by tool and domain                                  | TS test         |
| 25  | Storage quota exhausted mid-save                   | Controlled error, previous raw value byte-identical, revision retained | TS test         |
| 26  | Legacy store already over budget                   | May shrink, never grow                                                 | TS test         |
| 27  | 200 documents already stored                       | `create` refused with a controlled error                               | TS test         |
| 28  | Export fails                                       | UI shows the error and **no** `Exported:`/`Revision saved.` notice     | TS test         |
| 29  | Save fails                                         | No success notice; durable content unchanged                           | TS test         |
| 30  | Unsupported source → target via IPC                | Denied before any output is produced                                   | TS test         |

---

## 10. Full Verification

All commands were run against the final source, with no test disabled and no assertion weakened.

| Command                                                        | Result                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                    | **pass** — 0 errors, 0 warnings (`eslint src --max-warnings=0`, all packages)                                                                                                                 |
| `pnpm typecheck`                                               | **pass** — 0 errors across all packages                                                                                                                                                       |
| `pnpm test`                                                    | **pass** — all suites green, 0 failures                                                                                                                                                       |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | **pass** — 101 passed, 0 failed, 12 ignored                                                                                                                                                   |
| Ignored Rust tests (`cargo test -- --ignored`)                 | 11 passed; the signed-updater case requires the generated fixture directory and passed via `scripts/verify-signed-updater.py` below                                                           |
| `pnpm build`                                                   | **pass**                                                                                                                                                                                      |
| `pnpm build:binary`                                            | **pass** (release binary rebuilt from final source)                                                                                                                                           |
| `scripts/verify-native-startup.py`                             | **pass** — 2 boots, `integrity: ok`, `savedDocumentSurvivedRestart: true`                                                                                                                     |
| `scripts/verify-signed-updater.py`                             | **pass** — `signedDownloadAndInstallation: passed`, `tamperedPackageRejectedWithoutReplacement: passed`, `unsupportedArchiveRestoresOriginal: passed`, `productionKeyOrReleaseChanged: false` |

Test totals: **104 test files / 1 079 tests passed** across the workspace, including
**57 document-focused tests** in `apps/desktop` plus **11** in `packages/workspaces`.

Regression suites re-run explicitly and green:

- Phase 2B: `persistenceCorruption` (128), `persistence` (37), `persistenceRetention` (15),
  `repositoryStorage` (13).
- Phase 2C/2C.1: `subagentDelegationLifecycle` (15), `subagentTool` (38),
  `scheduledApprovalLifecycle` (13), `scheduledQueue` (4), `schedulerOwnership` (5).
- Phase 2D: `webFetch` (3), `janitorApproval` (14), `liveBrowserTools` (19).

Tauri updater `pubkey` in `apps/desktop/src-tauri/tauri.conf.json` verified intact and unmodified.
The native application boots without panic, both before and after the capability removal.

---

## 11. Files Changed

New:

| File                                                 | Lines       | Purpose                                                                                        |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `apps/desktop/src/csv.ts`                            | 100         | RFC 4180 parse/serialize + formula neutralization                                              |
| `apps/desktop/src/documentExport.integrity.test.ts`  | 536         | H-07 reproduction, pagination, M-18 structural validation, capability matrix, success contract |
| `apps/desktop/src/documentStorage.test.ts`           | 255         | M-20 budget, quota rollback, write atomicity, restart identity                                 |
| `apps/desktop/src/documentExportDestination.test.ts` | 90          | M-17 IPC surface: no host path from the renderer                                               |
| `docs/verification/document-integrity.md`            | this report | Phase 2E verification record                                                                   |

Modified:

| File                                                   | Focus                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/documentExport.ts`                   | Real PDF pagination, completeness contract, WinAnsi encoding, capability matrix, guard-raised XLSX/PPTX/CSV, ticket-based native write |
| `apps/desktop/src/DocumentsState.tsx`                  | Export buttons gated by `exportSupported`; honest success reporting; CSV button                                                        |
| `apps/desktop/src/DocumentsState.test.tsx`             | No-false-success and capability-gating tests                                                                                           |
| `apps/desktop/src/documentExport.test.ts`              | Format fixtures and refusal test aligned with the matrix                                                                               |
| `apps/desktop/src/documentTools.ts`                    | Byte-authoritative validation and accurate limit descriptions                                                                          |
| `apps/desktop/src/documentTools.test.ts`               | Tool/domain size-semantics agreement                                                                                                   |
| `apps/desktop/src/documents.ts`                        | Aggregate cap, count cap, single-write commit, controlled errors                                                                       |
| `apps/desktop/src/storageWrites.ts`                    | `StorageQuotaExceededError` + atomic `writeStorageValue` (+45 tracked lines)                                                           |
| `packages/workspaces/src/documents.ts`                 | Byte/code-point limit semantics, precise errors                                                                                        |
| `packages/workspaces/src/documents.test.ts`            | M-19 semantics at every boundary                                                                                                       |
| `apps/desktop/src-tauri/src/document_export.rs`        | Trusted-destination ticket model, 14 Rust tests                                                                                        |
| `apps/desktop/src-tauri/src/lib.rs`                    | Registers `DocumentExportState` and both export commands                                                                               |
| `apps/desktop/src-tauri/capabilities/default.json`     | Removes `dialog:allow-save` (now byte-identical to HEAD)                                                                               |
| `apps/desktop/src-tauri/gen/schemas/capabilities.json` | Regenerated by the build (byte-identical to HEAD)                                                                                      |

No unrelated file was reformatted, reverted, stashed or committed.

---

## 12. Unrelated Findings

Observed but deliberately **not** changed (out of scope):

1. **No in-app document deletion.** Documents can be created and revised but never deleted through the
   UI, so a user who reaches the count or byte cap must grow the limit or edit storage manually.
2. **`CURRENT_STATE.md` is stale** relative to the uncommitted document work. Per the "no docs cleanup"
   constraint it was left untouched.
3. **`docs/verification/documents.md`** (from the earlier document phase) still describes the old
   46-line PDF behaviour. It is stale, and updating it was out of scope.
4. **`authored` provenance on revisions** records the actor but not which runtime turn produced the
   revision, so document changes cannot be correlated with a chat turn after the fact.
5. **No spreadsheet-level validation for XLSX/PPTX** beyond structural correctness (no third-party
   reader is used to re-open the archives).
6. **`dialog:allow-open`** still grants the renderer the ability to obtain arbitrary _read_ paths, which
   is the existing (pre-Phase 2E) behaviour.

---

## 13. Remaining Risks

1. **Narrow TOCTOU window.** The parent directory is verified by canonical path and by device/inode
   before and after the file is opened, and `create_new` (O_EXCL) refuses a link planted at the final
   component. A same-user attacker who swaps the parent directory and swaps it back within that
   window could still redirect the write. Closing it fully would require `openat`-relative opens,
   which is a larger change than this phase allows; for the real threat model (a compromised
   renderer, not a local privileged attacker) the current checks are sufficient.
2. **Ticket-store growth is bounded but not persisted.** Tickets live in process memory only, so a
   restart invalidates pending exports — correct for security, but a user who restarts mid-dialog must
   choose the destination again.
3. **Aggregate storage cap vs. existing live data.** If a live profile already exceeds 8 MiB or 200
   documents, new growth is refused with a controlled error while all existing data is preserved. This
   is the deliberate "data preservation over convenience" fallback, not silent pruning.
4. **Byte-limit schema gap.** JSON Schema cannot express a UTF-8 byte limit. The `maxLength` shown to
   the model is a coarse pre-filter and the description says so; the domain remains authoritative. A
   model that relies only on `maxLength` may propose a value that the domain then rejects.
5. **PDF relies on the standard-14 Helvetica metrics.** Text width is computed from the AFM table for
   Helvetica; a viewer substituting a different font could wrap slightly differently from the layout
   IRIS computed, though no content is lost because each line is emitted as its own text object.
6. **CSV formula neutralization is opt-in.** The byte-faithful "Export original format" path
   deliberately does not rewrite the user's bytes, so a user who exports malicious CSV content in
   source form keeps it malicious — that is the documented contract, not a bug.

---

## 14. Final Working Tree

| Property                     | Baseline                                   | Final                                                  |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| HEAD                         | `53e32b4356f6e0639ecb8435bb7b18176b7b4eb5` | `53e32b4356f6e0639ecb8435bb7b18176b7b4eb5` (unchanged) |
| `git status --short` entries | 197                                        | 200                                                    |
| Modified tracked files       | 91                                         | 90                                                     |
| Untracked files              | 106                                        | 110                                                    |
| Staged changes               | none                                       | none                                                   |
| Stash                        | none                                       | none                                                   |
| Commit made                  | —                                          | none                                                   |

Delta versus baseline, item by item:

- `+ ?? apps/desktop/src/csv.ts`
- `+ ?? apps/desktop/src/documentStorage.test.ts`
- `+ ?? apps/desktop/src/documentExportDestination.test.ts`
- `+ ?? docs/verification/document-integrity.md` (this report)
- `+ M apps/desktop/src/storageWrites.ts` (+45 lines)
- `− M apps/desktop/src-tauri/capabilities/default.json` (restored to the committed content by removing
  `dialog:allow-save`)
- `− M apps/desktop/src-tauri/gen/schemas/capabilities.json` (regenerated; restored to committed content)

Every other entry is pre-existing uncommitted work from earlier phases and was left untouched. No work
was lost: the two files that dropped out of the modified list are byte-identical to the committed
revision, and the capability they contained was the over-grant this phase removed.

Baseline artifacts live only in the gitignored `node_modules/.phase2e/` and do not appear in
`git status`.
