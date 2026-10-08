# IRIS v0.3.4

IRIS v0.3.4 improves project checks, credential safety, document exports and browser networking.

## Highlights

- Project test commands require approval, run in workspace isolation and must pass before applying a task.
- Telegram and Discord can send opt-in generic project status; task output is never sent.
- Existing plaintext provider keys migrate to the operating system credential store only after IRIS verifies storage; provider errors redact credentials.
- Document exports handle XML-invalid characters and preserve Markdown headings and code fences in PowerPoint output.
- Project loading reports recoverable errors, and browser DNS lookups are bounded.

## Compatibility and limitations

Existing project, provider and channel settings remain valid; notifications default to off. Disconnected channels cannot send notifications; Discord has no inbound listener. macOS and Windows builds are tested on hosted runners, not end-user machines.

## Verification

Release workflow [#25](https://github.com/bubbadk/IRIS/actions/runs/37762389070) passed on Linux, macOS and Windows. The workflow ran TypeScript typecheck, lint, tests and the native Rust suite, then built signed platform packages and updater metadata.
