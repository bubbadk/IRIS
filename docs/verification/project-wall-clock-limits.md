# Project wall-clock limits

Unreleased local work, version 0.2.11, 2026-09-09.

Tasks can set an optional 1–1,440-minute wall-clock limit. Launch snapshots the selected limit and an absolute deadline on the run record. The runtime uses that persisted deadline to abort the active worker rather than merely displaying elapsed time.

The deadline applies to the entire run, including approval waits and pauses. An expired run is recorded as failed with a direct instruction to inspect the real outcome. It cannot silently resume from a checkpoint, repeat agent tools, or complete dependencies. A manually started follow-up run gets a fresh deadline from the current task configuration and retains the ordinary saved-report safeguards.

Domain tests cover deadline snapshotting, expiration during a worker event and refusal to resume a paused run after the deadline. Existing project result, checkpoint, permission and dependency tests remain part of the full test suite.

This is a wall-clock safety bound, not a provider billing quota. It cannot revoke an external side effect already dispatched to a tool or provider; IRIS treats that outcome as unknown and requires inspection. The active desktop process enforces the timer. If IRIS quits, normal recovery rules apply on the next launch.
