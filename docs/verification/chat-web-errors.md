# Chat formatting and public web-read errors

Verified locally on Linux, 2026-09-12. Source version remains **0.2.11**. This is a user-reported bug fix after QC-2, not a new gap-plan milestone. Existing working-tree changes and QC-1/QC-2 protections remain intact. No publication action occurred.

## Findings and changes

The screenshot showed collapsed Markdown, adjacent unstyled tool labels/statuses, and repeated failed web requests. The existing `RichMessage` only recognized bold spans and bare URLs. Message/tool class names had no corresponding layout rules, and flex shrinking let long replies overlap the header. The desktop web tools used browser `fetch` directly for third-party HTML, leaving them subject to webview cross-origin restrictions. This is consistent with the displayed `Load failed`; the user's original network trace was not available.

- Chat messages now use `react-markdown` with `remark-gfm` for headings, paragraphs, lists, tables, code and citations. Raw HTML is not activated and links/images are restricted to HTTP(S). Existing naked generated-image previews are retained. See the primary [react-markdown](https://github.com/remarkjs/react-markdown) and [remark-gfm](https://github.com/remarkjs/remark-gfm) documentation.
- Long messages scroll without shrinking over the header. Tool rows have distinct labels/statuses and visible failure/denial reasons. The active chat sits above the background telemetry panel, keeping its controls accessible.
- Installed-app public webpage GETs use a small native transport through the existing tool registration and permission executor. It supports HTTP(S), rejects URL credentials and private/local/reserved destinations, pins validated DNS addresses, revalidates redirects, refuses HTTPS downgrades, carries no cookies or bearer tokens, and limits reads to 20 seconds / 2 MiB. It makes direct connections rather than using environment proxies. Domain tools remain React/Tauri-independent; no tool permission was granted or relaxed.
- Search parsing supports the current DuckDuckGo title/snippet ordering and decodes redirect URLs once. Human challenges and unrecognized responses now fail explicitly instead of being called successful empty searches. Browser-preview network errors explain the limitation instead of exposing only `Load failed`.

## Actual verification

- `pnpm typecheck` and `pnpm lint`: passed, zero errors/warnings.
- `pnpm test`: **664 passed, 87 suites**. New tests cover Markdown structure/unsafe content/image continuity, native-vs-browser transport and error propagation, current search markup, challenge detection, unknown HTML and invalid limits. QC-1/QC-2 and existing permission/checkpoint regressions still pass.
- Ordinary Rust suite: **59 passed, 6 ignored**. The new ignored `web_read::tests::live_public_page` was additionally run explicitly and **passed**: production native transport retrieved `https://example.com`, found its actual content and refused a loopback destination. The five previous ignored integration tests were not run here.
- `pnpm build:binary`: passed, with existing large-chunk warnings. The `iris` launcher resolves to the rebuilt release binary. Two isolated native boots passed without panic and retained the actual prior QC-2 browser journey records in SQLite.
- `scripts/verify-chat-web.mjs`: actual Chromium UI with an explicitly labelled controlled worker, no model calls. Verified a long reply with a heading, table, numbered list, code and link; twelve readable error rows; non-overlapping header and accessible controls; and the retained formatted reply after reload. Screenshots inspected. The first harness attempt missed the initial command-bar interaction; the corrected script performs it and passes.
- Required updater public key and source version are unchanged. Targeted formatting and `git diff --check` pass. Repository-wide formatting still fails in **116 other files**; its checks were not weakened.

## Remaining limits

A live request to DuckDuckGo returned **HTTP 202 and a human-verification challenge** on this host. No search results were obtained in that check. This provider restriction is not bypassed or presented as a working search. The native public-page transport is verified separately; the UI worker and failure events are controlled fixtures, not live model verification. No end-to-end model-driven search or native-webview click journey is claimed.

Browser preview remains subject to CORS. Optional Firecrawl POST requests retain their existing browser transport and were not tested with credentials. Static extraction does not execute a site's JavaScript and does not guarantee readable content on protected/dynamic websites. The already-open IRIS process must be restarted to load the rebuilt frontend/native code.

Logs: `/tmp/iris-chat-{typecheck,lint,tests,rust,live-web,build,ui-smoke,native-boot,full-format}.log`. Reproduce the UI test with a local Vite origin and `IRIS_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-chat-web.mjs`; the script creates and reports a disposable profile.

The exact next planned milestone remains **QC-3 permission-gated test execution**, subject to a separate request. All eight gap-plan areas remain present.
