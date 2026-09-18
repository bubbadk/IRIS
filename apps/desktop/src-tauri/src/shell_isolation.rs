use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ShellIsolation {
    #[default]
    Workspace,
    Host,
}

/// Build a closed filesystem view; never fall back to host execution on setup failure.
pub fn command_builder(
    root: Option<&Path>,
    command: &str,
    mode: ShellIsolation,
) -> Result<Command, String> {
    if mode == ShellIsolation::Host {
        #[cfg(unix)]
        let mut builder = Command::new("/bin/bash");
        #[cfg(unix)]
        builder.args(["-lc", command]);
        #[cfg(windows)]
        let mut builder = Command::new("powershell");
        #[cfg(windows)]
        builder.args(["-NoProfile", "-Command", command]);
        if let Some(root) = root {
            builder.current_dir(root);
        }
        return Ok(builder);
    }
    #[cfg(not(target_os = "linux"))]
    return Err("Workspace isolation currently requires Linux and Bubblewrap. Host execution must be requested and approved explicitly.".into());
    #[cfg(target_os = "linux")]
    {
        let executable = Path::new("/usr/bin/bwrap");
        if !executable.is_file() {
            return Err("Workspace isolation is unavailable: install Bubblewrap. IRIS did not run the command on the host.".into());
        }
        let mut builder = Command::new(executable);
        builder.env_clear();
        builder.args([
            "--unshare-all",
            "--unshare-user",
            "--disable-userns",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--clearenv",
            "--ro-bind",
            "/usr",
            "/usr",
        ]);
        // Preserve both merged-/usr and traditional Linux layouts without exposing /etc or home.
        for name in ["/bin", "/sbin", "/lib", "/lib64"] {
            let path = Path::new(name);
            if let Ok(target) = std::fs::read_link(path) {
                builder.arg("--symlink").arg(target).arg(path);
            } else if path.is_dir() {
                builder.arg("--ro-bind").arg(path).arg(path);
            }
        }
        builder.args([
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/home/iris",
            "--setenv",
            "HOME",
            "/home/iris",
            "--setenv",
            "PATH",
            "/usr/local/bin:/usr/bin:/bin",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "TMPDIR",
            "/tmp",
        ]);
        if let Some(root) = root {
            builder.arg("--bind").arg(root).arg("/workspace");
        } else {
            builder.args(["--dir", "/workspace"]);
        }
        builder.args([
            "--chdir",
            "/workspace",
            "--",
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            command,
        ]);
        Ok(builder)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIsolationStatus {
    available: bool,
    detail: String,
}

#[tauri::command]
pub async fn workspace_shell_isolation_status() -> Result<ShellIsolationStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let result = command_builder(None, "true", ShellIsolation::Workspace).and_then(|mut builder| {
            builder.output().map_err(|e| e.to_string())
        });
        match result {
            Ok(output) if output.status.success() => ShellIsolationStatus {
                available: true,
                detail: "Linux isolation is available. Commands default to an offline sandbox with workspace access, read-only system tools and a temporary home. Host execution requires a separate explicit request and approval.".into(),
            },
            Ok(output) => ShellIsolationStatus {
                available: false,
                detail: format!("Workspace isolation could not start: {}. No host fallback is used.", String::from_utf8_lossy(&output.stderr).trim()),
            },
            Err(detail) => ShellIsolationStatus { available: false, detail },
        }
    }).await.map_err(|e| format!("Could not check shell isolation: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_mode_is_explicit_and_has_no_sandbox_claim() {
        assert_eq!(ShellIsolation::default(), ShellIsolation::Workspace);
        assert!(command_builder(None, "true", ShellIsolation::Host).is_ok());
        assert!(serde_json::from_str::<ShellIsolation>("\"automatic\"").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Requires Bubblewrap, Python 3 and enabled unprivileged user namespaces"]
    fn live_sandbox_hides_host_files_environment_and_network() {
        use std::{
            fs,
            net::TcpListener,
            time::{SystemTime, UNIX_EPOCH},
        };
        let base = std::env::temp_dir().join(format!(
            "iris-isolation-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = base.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let outside = base.join("private.txt");
        fs::write(&outside, "test-only private fixture").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("outside-link")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = format!(
            r#"python3 - <<'PY'
import os, pathlib, socket
assert os.environ.get('IRIS_SANDBOX_TEST_SECRET') is None
assert os.environ['HOME'] == '/home/iris'
assert not pathlib.Path({outside:?}).exists()
assert not pathlib.Path('/workspace/outside-link').exists()
assert not pathlib.Path('/proc/{host_pid}').exists()
assert not pathlib.Path('/etc/passwd').exists()
pathlib.Path('/workspace/result.txt').write_text('actual sandbox output')
try:
 pathlib.Path('/usr/iris-sandbox-test').write_text('blocked')
except OSError: pass
else: raise AssertionError('System directory is writable')
with socket.socket() as client:
 client.settimeout(1)
 try: client.connect(('127.0.0.1', {port}))
 except OSError: pass
 else: raise AssertionError('Host network is reachable')
print('filesystem, environment, process and network isolation verified')
PY"#,
            outside = outside.to_string_lossy(),
            host_pid = std::process::id()
        );
        let mut command = command_builder(Some(&root), &script, ShellIsolation::Workspace).unwrap();
        command.env("IRIS_SANDBOX_TEST_SECRET", "test-only");
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(root.join("result.txt")).unwrap(),
            "actual sandbox output"
        );
        assert_eq!(
            fs::read_to_string(&outside).unwrap(),
            "test-only private fixture"
        );
        fs::remove_dir_all(base).unwrap();
    }
}
