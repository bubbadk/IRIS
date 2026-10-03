# IRIS v0.3.4

This release improves project checks and status visibility, migrates older provider credentials safely, and makes document export and browser networking more reliable.

## Highlights

- Project tasks can require one exact test command. IRIS requests approval, runs it with workspace isolation, records its output and result, and does not allow the task to complete on a failed or missing check.
- Project status notifications are opt-in for Telegram and Discord. They contain generic status only, not task output. Telegram delivery uses configured allowed chats; Discord remains an outgoing webhook.
- Existing plaintext provider credentials are moved to the operating system credential store before configuration is saved without them. Provider errors are scrubbed so credentials are not exposed in error text.
- Document exports handle XML-invalid characters and preserve Markdown headings and code fences in PowerPoint output.
- Project loading reports recoverable errors, and browser DNS lookups have bounded workers and deadlines.

## Compatibility

Existing project, provider, and channel settings remain valid. Project status notifications default to off. Existing provider keys are migrated when the desktop application can verify that the operating system credential store retained them.

## Known limitations

- Project tests run only after explicit approval and in workspace isolation; a successful result is required before applying a task.
- A disconnected channel cannot deliver status notifications. Discord has no inbound listener.
- macOS and Windows user-machine behavior is not established by the local Linux checks.

## Verification

On the Linux development host, `pnpm typecheck` and `pnpm lint` pass. `pnpm test` passes 138 test files / 1437 tests. Rust tests and desktop binary startup were not run because Cargo is unavailable in this environment. This source candidate has not been built or published as a signed desktop release.
