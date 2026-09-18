use crate::process_output::{output_text, read_bounded};
use crate::shell_isolation::{command_builder, ShellIsolation};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

use crate::kill_process_tree;
use crate::workspace::{mounted_root, WorkspaceState};

const MAX_COMMAND_CHARS: usize = 8000;
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxShellResult {
    cwd: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    isolation: ShellIsolation,
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
    seconds
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS)
}

/// Always permission-gated. Workspace isolation is the default; host mode is explicit.
#[tauri::command]
pub async fn run_workspace_shell_command(
    state: State<'_, WorkspaceState>,
    command: String,
    timeout_seconds: Option<u64>,
    isolation: Option<ShellIsolation>,
) -> Result<SandboxShellResult, String> {
    let root = mounted_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_shell_at(
            root,
            command,
            timeout_seconds,
            isolation.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("Shell execution failed: {error}"))?
}

fn run_shell_at(
    root: PathBuf,
    command: String,
    timeout_seconds: Option<u64>,
    isolation: ShellIsolation,
) -> Result<SandboxShellResult, String> {
    validate_command(&command)?;
    let timeout = effective_timeout(timeout_seconds);
    let mut builder = command_builder(Some(&root), &command, isolation)?;
    builder
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        pipe: impl std::io::Read + Send + 'static,
        done: Arc<AtomicBool>,
    ) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let buffer = read_bounded(pipe);
            done.store(true, Ordering::SeqCst);
            buffer
        })
    }
    let (stdout_done, stderr_done) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
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
            // Keep the drain handles: the final result must include output produced before timeout.
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

    let stdout_bytes = stdout_handle
        .take()
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr_bytes = stderr_handle
        .take()
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let mut stderr = output_text(stderr_bytes);
    if timed_out {
        stderr.push_str(&format!(
            "\n[command timed out after {timeout} seconds and was stopped]"
        ));
    }
    Ok(SandboxShellResult {
        cwd: if isolation == ShellIsolation::Workspace {
            "/workspace".into()
        } else {
            root.to_string_lossy().replace('\\', "/")
        },
        exit_code: process
            .try_wait()
            .ok()
            .flatten()
            .and_then(|status| status.code()),
        stdout: output_text(stdout_bytes),
        stderr,
        timed_out,
        isolation,
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
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Requires Bubblewrap and enabled unprivileged user namespaces"]
    fn live_isolated_runner_returns_output_and_stops_at_timeout() {
        let root = std::env::temp_dir().join(format!(
            "iris-shell-runner-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let result = run_shell_at(
            root.clone(),
            "pwd; printf checked > result.txt".into(),
            Some(5),
            ShellIsolation::Workspace,
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert_eq!(result.cwd, "/workspace");
        assert_eq!(result.stdout.trim(), "/workspace");
        assert_eq!(
            std::fs::read_to_string(root.join("result.txt")).unwrap(),
            "checked"
        );
        let started = Instant::now();
        let stopped = run_shell_at(
            root.clone(),
            "printf started; sleep 60".into(),
            Some(1),
            ShellIsolation::Workspace,
        )
        .unwrap();
        assert!(stopped.timed_out);
        assert!(stopped.stdout.contains("started"));
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(root).unwrap();
    }
}
