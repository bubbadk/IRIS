use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

use crate::kill_process_tree;
use crate::workspace::{mounted_root, WorkspaceState};

const MAX_COMMAND_CHARS: usize = 8000;
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 300;
const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxShellResult {
    cwd: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

pub fn validate_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("A command is required.".to_string());
    }
    if command.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!(
            "Commands are limited to {MAX_COMMAND_CHARS} characters."
        ));
    }
    Ok(())
}

pub fn effective_timeout(seconds: Option<u64>) -> u64 {
    seconds.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS)
}

/// Runs one command in the mounted workspace root through `/bin/bash -lc`.
///
/// This is NOT an OS-level jail: the process starts in the workspace directory but the
/// command itself can reference paths outside it. The safety boundary is the permission
/// gate — every non-yolo agent must get an explicit user approval before this runs.
#[tauri::command]
pub fn run_workspace_shell_command(
    state: State<'_, WorkspaceState>,
    command: String,
    timeout_seconds: Option<u64>,
) -> Result<SandboxShellResult, String> {
    validate_command(&command)?;
    let timeout = effective_timeout(timeout_seconds);
    let root: PathBuf = mounted_root(&state)?;

    #[cfg(unix)]
    let mut builder = {
        let mut builder = Command::new("/bin/bash");
        builder.arg("-lc").arg(&command);
        builder
    };
    #[cfg(windows)]
    let mut builder = {
        let mut builder = Command::new("powershell");
        builder.arg("-NoProfile").arg("-Command").arg(&command);
        builder
    };
    builder.current_dir(&root);
    builder.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group so the timeout can kill the whole tree, matching the
        // janitor runner.
        builder.process_group(0);
    }

    let mut process = builder
        .spawn()
        .map_err(|error| format!("Could not start the command: {error}"))?;

    // Drain both pipes on dedicated threads; waiting on the child while it fills the
    // 64 KiB pipe buffer would hang every chatty command.
        fn drain_pipe(
            mut pipe: impl std::io::Read + Send + 'static,
        done: Arc<AtomicBool>,
    ) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            done.store(true, Ordering::SeqCst);
            buffer
        })
    }
    let (stdout_done, stderr_done) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    let mut stdout_handle = process
        .stdout
        .take()
        .map(|pipe| drain_pipe(pipe, Arc::clone(&stdout_done)));
    let mut stderr_handle = process
        .stderr
        .take()
        .map(|pipe| drain_pipe(pipe, Arc::clone(&stderr_done)));

    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut timed_out = false;
    loop {
        match process.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                kill_process_tree(process.id());
                if let Some(handle) = stdout_handle.take() {
                    let _ = handle.join();
                }
                if let Some(handle) = stderr_handle.take() {
                    let _ = handle.join();
                }
                let _ = process.wait();
                return Err(format!("Could not inspect the command: {error}"));
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            kill_process_tree(process.id());
            if let Some(handle) = stdout_handle.take() {
                let _ = handle.join();
            }
            if let Some(handle) = stderr_handle.take() {
                let _ = handle.join();
            }
            let _ = process.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if !timed_out {
        // Grandchildren may still hold the pipe write ends after the leader exits;
        // give them a short grace period, then kill the group to force EOF.
        let drain_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < drain_deadline
            && !(stdout_done.load(Ordering::SeqCst) && stderr_done.load(Ordering::SeqCst))
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !(stdout_done.load(Ordering::SeqCst) && stderr_done.load(Ordering::SeqCst)) {
            kill_process_tree(process.id());
        }
    }

    let truncate = |bytes: Vec<u8>| {
        let text = String::from_utf8_lossy(&bytes).to_string();
        if text.chars().count() > OUTPUT_LIMIT {
            format!(
                "{}\n[output truncated]",
                text.chars().take(OUTPUT_LIMIT).collect::<String>()
            )
        } else {
            text
        }
    };
    let mut stderr = truncate(
        stderr_handle
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
    );
    if timed_out {
        stderr.push_str(&format!(
            "\n[command timed out after {timeout} seconds and was stopped]"
        ));
    }
    Ok(SandboxShellResult {
        cwd: root.to_string_lossy().replace('\\', "/"),
        exit_code: process.try_wait().ok().flatten().and_then(|status| status.code()),
        stdout: truncate(
            stdout_handle
                .take()
                .and_then(|handle| handle.join().ok())
                .unwrap_or_default(),
        ),
        stderr,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_commands() {
        assert!(validate_command("   ").is_err());
        assert!(validate_command("").is_err());
    }

    #[test]
    fn rejects_oversized_commands() {
        let long = "x".repeat(MAX_COMMAND_CHARS + 1);
        assert!(validate_command(&long).is_err());
    }

    #[test]
    fn accepts_bounded_commands() {
        assert!(validate_command("ls -la").is_ok());
    }

    #[test]
    fn clamps_timeout() {
        assert_eq!(effective_timeout(None), 60);
        assert_eq!(effective_timeout(Some(0)), 1);
        assert_eq!(effective_timeout(Some(5)), 5);
        assert_eq!(effective_timeout(Some(10_000)), MAX_TIMEOUT_SECS);
    }
}
