# Durable schedule queue

Unreleased local work, version 0.2.11, 2026-09-09.

## Behavior

- The native main runtime obtains an OS file lock before reconciling or dispatching schedules. Another IRIS process shows that execution is owned elsewhere. The file handle stays alive until process exit; there is no expiring lease that could accidentally replay a slow job. Unix uses `flock`; Windows uses an exclusive file handle. Linux is tested locally.
- Saving a due occurrence and advancing its schedule share one SQLite transaction. The queue drains saved occurrences independently of the schedule's next due time, including completed one-time schedules. Each occurrence retains its original prompt and agent.
- Before any agent dispatch, a transaction changes the occurrence to running and records its execution claim. Only one claimant succeeds. Jobs wait if their agent is busy or has a pending approval.
- A persistent **Pause new jobs / Resume queue** control in Schedules holds new dispatches and future occurrence materialization. Current jobs and explicit permission decisions can finish. Disabling a schedule affects future occurrences; its already saved jobs remain queued. Deleting a schedule makes its queued jobs fail visibly before execution.
- Pending jobs and safe preflight retries are never evicted by the finished-history limit. Malformed run storage aborts without overwriting existing data.
- Only configuration preflight is retryable. A failure after dispatch, even before the first worker event, is not replayed automatically. Interrupted claimed runs and old queued records without proof of a safe claim protocol become failed records requiring inspection. Pending approvals retain the existing permission flow.

## Verification

- Domain tests cover restart of an already advanced one-time schedule, immutable queued prompts/agents, persisted claims before worker effects, pause, busy agents, overlapping ticks, safe preflight retry and refusal to replay uncertain work.
- Native transaction tests cover two competing enqueues/claims, persistent pause and disk failure without partial schedule advancement.
- Storage tests retain an older pending job beyond 500 completed entries and reject malformed queue data without data loss.
- A native test verifies exclusive OS ownership and lock release when its handle closes.
- An isolated browser profile exercises the actual pause/resume controls and their persistence, then explicitly runs a labelled offline executor with the real queue/repository/domain code. A saved one-time job runs exactly once after resuming. Browser preview itself does not dispatch schedules. No model, external message or execution tool is called.
- `scripts/verify-native-startup.py` verifies two boots, native scheduler initialization, persisted queue pause and an untouched queued fixture alongside memory, documents and knowledge in a disposable profile.

## Limits

This is a durable queue hosted by the existing native app, not an independent daemon. Closing the main window retains the existing tray process; Quit, logout and shutdown stop it. Sleep pauses processing until the machine wakes. There is no project-task queue, OS autostart installation, remote approval channel, notification delivery or duration/cost cap in this change. A process that cannot acquire ownership must be restarted after the owner exits. Process locking assumes every participating executable uses this new protocol; quit older running builds before opening this one.
