# Document workspace verification

Working-tree feature for version 0.2.11, not a published release.

Documents is a movable desktop window available in the dock and command routing. Markdown, text, HTML, SVG, JSON and CSV documents have durable, author-attributed revisions. Agent tools create, read, list and revise saved documents; write operations use the existing permission policy. Saving inside IRIS does not claim that a file has been exported or its contents verified.

Native storage uses scoped SQLite transactions and checks the expected revision before each edit. Competing writers cannot silently overwrite each other. Browser preview uses localStorage. Content is limited to 256 KiB per revision and 50 revisions per document; reaching the cap retains history and requires a copy. Unsaved editor text is a draft and must be saved before closing the window. Refresh and focus reload saved records without replacing the draft; stale saves are rejected.

Original-format export preserves selected saved content. Markdown and text can also be exported as real DOCX archives with headings, bullets and code font. Native export uses a save dialog and create-only writes, refusing to replace existing files. Other Markdown constructs remain literal; PDF, XLSX and PPTX export are not implemented.

HTML and SVG are static previews in a sandboxed iframe with no script or same-origin permission. Sanitization removes active elements, navigation and event handlers, and the preview CSP blocks external resources. Exported source files retain original content; the preview restriction is not a claim about what another application will execute when opening an exported HTML file.

## Checks

- Domain tests: immutable revision history and author/turn provenance, stale revision refusal, invalid data/JSON, UTF-8 size, history cap, filename sanitation.
- Repository tests: two concurrent editors produce one successful revision, restart retains history, failed durable commits retain the original.
- Agent tool tests: actual stored content, list/read identity, stale revision refusal and invalid-input failure.
- UI test: create, protect unsaved edits, save, remount, select a historical revision and restore it as a new revision.
- Export tests: open the actual DOCX ZIP and verify OOXML text, Unicode, heading styles, numbering and selected content. Native test writes real bytes and refuses overwrite.
- Browser check: create and save two revisions through the actual app, reload, download a real DOCX and inspect its LibreOffice-rendered page. The isolated test profile contains explicitly labelled verification content.
- Native startup script checks two boots, SQLite integrity and retention of both memory and document data. No provider calls or messages are sent.
