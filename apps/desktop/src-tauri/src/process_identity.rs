//! IRIS Phase 2H.1 — process identity for cross-process agent execution leases.
//!
//! The JavaScript lease authority needs three facts about the OS process it runs in: its pid,
//! a nonce that is unique to this process *instance* (defeating pid reuse), and whether some
//! other recorded pid is still alive. The nonce is generated once per process at first use and
//! kept in memory; a restarted process with the same pid gets a fresh nonce, so a stale lease
//! recorded by a dead instance is recoverable while a live foreign instance never is.
//!
//! IRIS Phase 2H.3 — liveness is a tri-state verdict, not a boolean. `process_is_alive` answers
//! `{ status: 'alive' | 'dead' | 'unknown', reason?: string }`, where `reason` is serialized
//! only for `unknown`. Consumers must treat `unknown` as *not dead*: an indeterminate probe
//! must never authorize taking over a possibly live foreign lease. (IPC transport failures
//! never reach this verdict at all; the TS adapter maps them to the same conservative
//! "not dead" reading.)
//!
//! Verdict rules on Unix via `kill(pid, 0)`:
//! - success → `alive` (the target exists and this user may signal it),
//! - `EPERM` → `alive` (POSIX: the target exists but may not be signaled by this user),
//! - `ESRCH` → `dead` (no process carries that pid at probe time),
//! - any other errno, or a failure without a decodable errno → `unknown` naming the pid and
//!   errno in the reason.
//!
//! Documented limits:
//! - Pids are recycled by the kernel. `dead` is true only at probe time. The lease nonce
//!   distinguishes runtimes, but this probe cannot verify a foreign process's nonce. A live
//!   reused pid blocks conservatively; reuse after a dead probe is a residual TOCTOU window.
//! - An exited-but-unreaped zombie process still answers `kill(pid, 0)` with success and so
//!   reads as `alive`. IRIS processes are not children of the probing process, so a zombie is
//!   not expected among probed pids.
//! - The verdict is a point-in-time snapshot; the target may exit immediately after a probe.
//! - Non-Unix targets (including Windows) have no probe implementation here. No dependency
//!   already present in `Cargo.toml` exposes a Windows process API (OpenProcess and friends),
//!   and adding dependencies was out of scope, so those targets return an explicit
//!   `unknown` ("unsupported") rather than guessing. A real Windows probe can later replace
//!   `unsupported_verdict` behind the same tri-state contract.
//! - Pids that must never reach a probe are refused as `unknown` with a reason: pid 0 would
//!   address the caller's whole process group, and any pid above `i32::MAX` cannot be
//!   represented as a Unix `pid_t` and would alias a negative (process-group) selector.
//! - `reason` strings are human diagnostics. Consumers must branch on `status`, never on
//!   parsing `reason`.
use serde::Serialize;
use std::sync::Mutex;

static INSTANCE_NONCE: Mutex<Option<String>> = Mutex::new(None);

fn nonce() -> String {
    let mut held = INSTANCE_NONCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if held.is_none() {
        *held = Some(format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
    }
    held.clone().unwrap_or_default()
}

#[tauri::command]
pub fn process_instance_nonce() -> String {
    nonce()
}

/// The liveness status of one probed pid, serialized lowercase for the TS contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessLivenessStatus {
    /// A process exists at that pid right now (signalable, or existing but not signalable).
    Alive,
    /// No process carries that pid right now.
    Dead,
    /// The probe could not decide; consumers must treat this as *not dead*.
    Unknown,
}

/// Tri-state native liveness verdict for one pid. `reason` is serialized only for `unknown`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProcessLiveness {
    status: ProcessLivenessStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl ProcessLiveness {
    fn alive() -> Self {
        Self {
            status: ProcessLivenessStatus::Alive,
            reason: None,
        }
    }

    fn dead() -> Self {
        Self {
            status: ProcessLivenessStatus::Dead,
            reason: None,
        }
    }

    fn unknown(reason: String) -> Self {
        debug_assert!(!reason.trim().is_empty(), "an unknown verdict must say why");
        Self {
            status: ProcessLivenessStatus::Unknown,
            reason: Some(reason),
        }
    }
}

/// Pids that must never reach a probe, with the reason they were refused. Pid 0 addresses the
/// caller's whole process group, and any pid above the signed `pid_t` range would alias a
/// negative (process-group) selector in the Unix `kill` call.
fn invalid_pid_reason(pid: u32) -> Option<String> {
    if pid == 0 {
        Some(
            "pid 0 addresses the caller's whole process group rather than one process; it is not probed"
                .to_string(),
        )
    } else if pid > i32::MAX as u32 {
        Some(format!(
            "pid {pid} exceeds the signed pid range and would alias a negative process-group selector; it is not probed"
        ))
    } else {
        None
    }
}

/// Pure errno → verdict mapping for a failed `kill(pid, 0)` on Unix. No syscall: tests feed
/// synthetic errno values directly.
#[cfg(unix)]
fn kill_failure_verdict(errno: Option<i32>, pid: u32) -> ProcessLiveness {
    match errno {
        Some(e) if e == libc::EPERM => {
            // POSIX: the target exists, but this user may not signal it. Existing is alive.
            ProcessLiveness::alive()
        }
        Some(e) if e == libc::ESRCH => {
            // No process carries that pid at probe time.
            ProcessLiveness::dead()
        }
        Some(e) => ProcessLiveness::unknown(format!(
            "kill({pid}, 0) failed with errno {e} ({}); the liveness probe is indeterminate",
            std::io::Error::from_raw_os_error(e)
        )),
        None => ProcessLiveness::unknown(format!(
            "kill({pid}, 0) failed without a decodable errno; the liveness probe is indeterminate"
        )),
    }
}

/// The non-Unix verdict: probing is genuinely unimplemented here, so the answer is an explicit
/// conservative `unknown` rather than a guess. A real Windows probe (OpenProcess and friends)
/// can replace this body later without changing the tri-state contract.
#[cfg_attr(unix, allow(dead_code))] // reached only by `#[cfg(not(unix))]` builds; tested everywhere
fn unsupported_verdict() -> ProcessLiveness {
    ProcessLiveness::unknown(
        "process liveness probing is not implemented on this platform (kill(pid, 0) is unavailable); the verdict is conservatively unknown"
            .to_string(),
    )
}

/// Native tri-state liveness probe for the cross-process lease authority. Callers must treat
/// `unknown` as *not dead*: an indeterminate probe never authorizes lease takeover.
#[tauri::command]
pub fn process_is_alive(pid: u32) -> ProcessLiveness {
    if let Some(reason) = invalid_pid_reason(pid) {
        return ProcessLiveness::unknown(reason);
    }
    #[cfg(unix)]
    {
        // `pid` fits a signed `pid_t` here (guarded above), so the cast cannot alias a
        // negative process-group selector.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            ProcessLiveness::alive()
        } else {
            kill_failure_verdict(std::io::Error::last_os_error().raw_os_error(), pid)
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        unsupported_verdict()
    }
}

#[tauri::command]
pub fn process_own_pid() -> u32 {
    std::process::id()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nonce_is_stable_within_this_process() {
        assert_eq!(nonce(), nonce());
        assert!(!nonce().is_empty());
    }

    #[test]
    fn the_own_pid_is_reported_verbatim() {
        assert_eq!(process_own_pid(), std::process::id());
    }

    #[test]
    fn this_process_is_alive_without_a_reason() {
        let verdict = process_is_alive(std::process::id());
        assert_eq!(verdict, ProcessLiveness::alive());
        assert_eq!(verdict.status, ProcessLivenessStatus::Alive);
        assert_eq!(verdict.reason, None);
    }

    #[test]
    fn a_deterministically_missing_positive_pid_is_dead_without_a_reason() {
        // Any pid above every mainstream Unix pid_max (Linux caps at 2^22, macOS far lower)
        // but inside the signed pid range is guaranteed to answer ESRCH.
        let verdict = process_is_alive(1_000_000_000);
        assert_eq!(verdict, ProcessLiveness::dead());
        assert_eq!(verdict.status, ProcessLivenessStatus::Dead);
        assert_eq!(verdict.reason, None);
    }

    #[test]
    fn process_group_aliases_are_refused_as_unknown() {
        for pid in [0, u32::MAX - 7, i32::MAX as u32 + 1] {
            let verdict = process_is_alive(pid);
            assert_eq!(verdict.status, ProcessLivenessStatus::Unknown, "pid {pid}");
            let reason = verdict.reason.expect("unknown verdicts carry a reason");
            assert!(!reason.trim().is_empty(), "pid {pid}");
            assert!(reason.contains("not probed"), "pid {pid}: {reason}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn kill_errno_verdicts_map_without_making_a_syscall() {
        assert_eq!(
            kill_failure_verdict(Some(libc::EPERM), 4242),
            ProcessLiveness::alive()
        );
        assert_eq!(
            kill_failure_verdict(Some(libc::ESRCH), 4242),
            ProcessLiveness::dead()
        );
        let indeterminate = kill_failure_verdict(Some(libc::EINVAL), 4242);
        assert_eq!(indeterminate.status, ProcessLivenessStatus::Unknown);
        let reason = indeterminate.reason.expect("unknown verdicts carry a reason");
        assert!(reason.contains("4242"), "{reason}");
        assert!(
            reason.contains(&libc::EINVAL.to_string()),
            "the raw errno appears in the reason: {reason}"
        );
        let undecodable = kill_failure_verdict(None, 4242);
        assert_eq!(undecodable.status, ProcessLivenessStatus::Unknown);
        assert!(undecodable
            .reason
            .expect("unknown verdicts carry a reason")
            .contains("4242"));
    }

    #[test]
    fn the_unsupported_platform_verdict_is_conservatively_unknown() {
        let verdict = unsupported_verdict();
        assert_eq!(verdict, ProcessLiveness::unknown(
            "process liveness probing is not implemented on this platform (kill(pid, 0) is unavailable); the verdict is conservatively unknown"
                .to_string(),
        ));
        assert_eq!(verdict.status, ProcessLivenessStatus::Unknown);
        let reason = verdict.reason.expect("unsupported verdicts carry a reason");
        assert!(reason.contains("not implemented"), "{reason}");
    }

    #[test]
    fn the_wire_format_is_status_plus_a_reason_only_for_unknown() {
        assert_eq!(
            serde_json::to_value(ProcessLiveness::alive()).unwrap(),
            serde_json::json!({ "status": "alive" })
        );
        assert_eq!(
            serde_json::to_value(ProcessLiveness::dead()).unwrap(),
            serde_json::json!({ "status": "dead" })
        );
        assert_eq!(
            serde_json::to_value(ProcessLiveness::unknown("why".to_string())).unwrap(),
            serde_json::json!({ "status": "unknown", "reason": "why" })
        );
    }
}
