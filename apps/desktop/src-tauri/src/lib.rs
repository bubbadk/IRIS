use serde::Serialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

mod catalog;
mod mcp;
mod oauth;
mod workspace;

#[cfg(target_os = "linux")]
fn should_force_shared_memory_transport(
    has_transport_override: bool,
    iris_renderer: Option<&str>,
    session_type: Option<&str>,
    has_nvidia_driver: bool,
) -> bool {
    if has_transport_override {
        return false;
    }

    match iris_renderer.map(str::trim) {
        Some(renderer) if renderer.eq_ignore_ascii_case("accelerated") => false,
        Some(renderer) if renderer.eq_ignore_ascii_case("compatibility") => true,
        _ => {
            has_nvidia_driver
                || session_type.is_some_and(|session| session.eq_ignore_ascii_case("wayland"))
        }
    }
}

fn configure_linux_webkit_renderer() {
    #[cfg(target_os = "linux")]
    if should_force_shared_memory_transport(
        std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_some()
            || std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
        std::env::var("IRIS_WEBKIT_RENDERER").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::path::Path::new("/proc/driver/nvidia/version").exists()
            || std::path::Path::new("/sys/module/nvidia/version").exists(),
    ) {
        // NVIDIA and some Wayland/GBM combinations reject WebKitGTK's hardware DMA-BUF surfaces.
        // Shared-memory transport keeps a valid backing store without disabling GPU compositing.
        std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod renderer_tests {
    use super::should_force_shared_memory_transport;

    #[test]
    fn keeps_hardware_transport_on_non_nvidia_x11() {
        assert!(!should_force_shared_memory_transport(
            false,
            None,
            Some("x11"),
            false
        ));
    }

    #[test]
    fn uses_shared_memory_transport_on_wayland_by_default() {
        assert!(should_force_shared_memory_transport(
            false,
            None,
            Some("wayland"),
            false
        ));
    }

    #[test]
    fn uses_shared_memory_transport_with_the_nvidia_driver() {
        assert!(should_force_shared_memory_transport(
            false,
            None,
            Some("x11"),
            true
        ));
    }

    #[test]
    fn supports_an_explicit_iris_transport_choice() {
        assert!(!should_force_shared_memory_transport(
            false,
            Some("accelerated"),
            Some("wayland"),
            true
        ));
        assert!(should_force_shared_memory_transport(
            false,
            Some("compatibility"),
            Some("x11"),
            false
        ));
    }

    #[test]
    fn never_replaces_an_explicit_webkit_transport_setting() {
        assert!(!should_force_shared_memory_transport(
            true,
            Some("compatibility"),
            Some("wayland"),
            true
        ));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshot {
    operating_system: String,
    architecture: String,
    app_version: String,
}

#[tauri::command]
fn inspect_host() -> HostSnapshot {
    HostSnapshot {
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostMetrics {
    operating_system: String,
    architecture: String,
    app_version: String,
    hostname: Option<String>,
    cpu_count: Option<usize>,
    load_average: Option<[f64; 3]>,
    memory_total_bytes: Option<u64>,
    memory_available_bytes: Option<u64>,
    uptime_seconds: Option<u64>,
}

fn read_load_average() -> Option<[f64; 3]> {
    let contents = std::fs::read_to_string("/proc/loadavg").ok()?;
    let mut fields = contents.split_whitespace();
    let one = fields.next()?.parse().ok()?;
    let five = fields.next()?.parse().ok()?;
    let fifteen = fields.next()?.parse().ok()?;
    Some([one, five, fifteen])
}

fn read_meminfo_kb(key: &str) -> Option<u64> {
    let contents = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let value = rest.trim_start_matches(':').trim();
            let kilobytes = value.split_whitespace().next()?.parse::<u64>().ok()?;
            return Some(kilobytes.saturating_mul(1024));
        }
    }
    None
}

fn read_uptime_seconds() -> Option<u64> {
    let contents = std::fs::read_to_string("/proc/uptime").ok()?;
    let seconds: f64 = contents.split_whitespace().next()?.parse().ok()?;
    Some(seconds as u64)
}

fn read_hostname() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Live, read-only host telemetry from the kernel's own counters. Every field is optional so an
/// unavailable source reads as "unknown" instead of a fabricated number.
#[tauri::command]
fn inspect_host_metrics() -> HostMetrics {
    HostMetrics {
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        hostname: read_hostname(),
        cpu_count: std::thread::available_parallelism().ok().map(|value| value.get()),
        load_average: read_load_average(),
        memory_total_bytes: read_meminfo_kb("MemTotal"),
        memory_available_bytes: read_meminfo_kb("MemAvailable"),
        uptime_seconds: read_uptime_seconds(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpGetResult {
    status: u16,
    body: String,
}

/// Read-only JSON GET for provider model discovery. Some model-list endpoints (for example
/// OpenRouter's `/embeddings/models`) send no CORS headers, so the webview cannot read them; this
/// native path is not bound by CORS. It is deliberately narrow: HTTPS only (HTTP just on loopback),
/// no credentials in the URL, no redirects (so a bearer token never crosses an origin), bounded body.
#[tauri::command]
async fn provider_http_get_json(url: String, token: Option<String>) -> Result<HttpGetResult, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That address is not a valid URL.".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("Model discovery must use HTTPS, or HTTP only on localhost.".to_string()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Model discovery credentials must not be part of the URL.".to_string());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not start model discovery: {error}"))?;
    let mut request = client.get(parsed).header("accept", "application/json");
    if let Some(token) = token.as_deref().map(str::trim).filter(|token| !token.is_empty()) {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Model discovery request failed: {error}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read the model discovery response: {error}"))?;
    let body = if text.len() > 512 * 1024 {
        text.chars().take(512 * 1024).collect::<String>()
    } else {
        text
    };
    Ok(HttpGetResult { status, body })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JanitorCommandResult {
    target: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JanitorDiagnosticResult {
    target: String,
    check: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JanitorHttpResult {
    status: u16,
    body: String,
}

#[tauri::command]
async fn janitor_projectcockpit_request(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<JanitorHttpResult, String> {
    let method = method.trim().to_ascii_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str()) {
        return Err("ProjectCockpit method is not supported.".to_string());
    }
    if !path.starts_with("/api/") || path.contains("..") || path.contains('?') || path.len() > 240 {
        return Err(
            "ProjectCockpit path must be a bounded /api/ path without traversal or queries."
                .to_string(),
        );
    }
    let url = format!("http://192.168.1.70{path}");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create ProjectCockpit client: {error}"))?;
    let request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?,
        url,
    );
    let request = if method == "GET" || method == "DELETE" {
        request
    } else {
        let payload = serde_json::to_string(&body.unwrap_or(serde_json::Value::Null))
            .map_err(|error| format!("Could not encode ProjectCockpit request: {error}"))?;
        request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(payload)
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("ProjectCockpit request failed: {error}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read ProjectCockpit response: {error}"))?;
    let body = if text.len() > 64 * 1024 {
        format!(
            "{}\n[response truncated]",
            text.chars().take(64 * 1024).collect::<String>()
        )
    } else {
        text
    };
    Ok(JanitorHttpResult { status, body })
}

/// Whether `command` invokes `sudo` as a standalone word (not e.g. part of `sudoku` or a
/// substring inside a quoted string we can't fully parse). Used to ask for a password
/// up front instead of letting the process block on a terminal nobody is watching.
fn command_needs_sudo(command: &str) -> bool {
    command.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-').any(|word| word == "sudo")
}

/// Collapse whitespace runs and strip quote/backslash characters so guardrail
/// matching cannot be bypassed with `docker    rm`, tab separators, or
/// `"docker ""rm"`-style quoting. Token-aware checks then work on the result.
fn normalize_for_guardrail(command: &str) -> String {
    let stripped: String = command
        .chars()
        .map(|c| if c == '"' || c == '\'' || c == '\\' { ' ' } else { c })
        .collect();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()
}

/// Returns the guardrail reason when `command` tries to destroy a protected
/// service or change network configuration, or None when allowed. Matching is
/// token-aware: `ip addr show` must NOT trip the "add" mutator check (the old
/// substring check blocked read-only diagnostics because "addr" contains "add").
fn guardrail_violation(command: &str) -> Option<&'static str> {
    let lowered = normalize_for_guardrail(command);
    let padded = format!(" {lowered} ");
    let protected_targets = [
        "nginx-proxy-manager-official",
        "unraid-cloudflared-tunnel",
        "hermes-agent",
        "litellm-proxy",
        "postgresql18",
        "mysql",
        "dockersocket",
    ];
    let destructive = [
        "docker stop",
        "docker rm",
        "docker rmi",
        "docker kill",
        "docker container stop",
        "docker container rm",
        "docker container kill",
        "docker container rmi",
    ];
    if destructive.iter().any(|operation| lowered.contains(operation))
        && protected_targets.iter().any(|target| lowered.contains(target))
    {
        return Some(
            "Janitor guardrail blocked a destructive command against a protected service.",
        );
    }
    // Prune commands cannot be scoped to a named container, so they can destroy
    // stopped protected services invisibly — block them outright.
    if lowered.contains("docker system prune") || lowered.contains("docker container prune") {
        return Some(
            "Janitor guardrail blocked an unscoped prune command that could destroy protected services.",
        );
    }
    let network_objects = [
        "ip addr",
        "ip address",
        "ip route",
        "ip link",
        "ip -6 addr",
        "ip -6 route",
        "nmcli",
        "ifconfig",
    ];
    let mutators = [
        " add ", " del ", " delete ", " replace ", " flush ", " set ", " modify ",
    ];
    if network_objects.iter().any(|object| lowered.contains(object))
        && mutators.iter().any(|mutator| padded.contains(mutator))
    {
        return Some("Janitor guardrail blocked a network interface or route change.");
    }
    None
}

#[cfg(unix)]
fn write_askpass_script(password: &str) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "iris-askpass-{}-{}.sh",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    // The password is embedded base64-encoded inside a 0700 script instead of a
    // process environment variable: environments are inherited by every
    // descendant process and readable via /proc/<pid>/environ, while this file
    // is only readable by the owning user and is deleted after the run.
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(password.len().div_ceil(3) * 4);
    for chunk in password.as_bytes().chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        encoded.push(TABLE[(n >> 18) as usize & 63] as char);
        encoded.push(TABLE[(n >> 12) as usize & 63] as char);
        encoded.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        encoded.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    std::fs::write(
        &path,
        format!("#!/bin/sh\nprintf '%s' '{encoded}' | base64 -d\n"),
    )
    .map_err(|error| format!("Could not prepare the sudo password helper: {error}"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure the sudo password helper: {error}"))?;
    Ok(path)
}

#[cfg(not(unix))]
fn write_askpass_script(_password: &str) -> Result<std::path::PathBuf, String> {
    Err("SUDO askpass is only supported on Unix systems.".to_string())
}

#[cfg(unix)]
fn kill_process_tree(pid: u32) {
    // The child was started as its own process group leader (process_group(0)),
    // so killing -pgid takes down wrappers and grandchildren that inherited the
    // pipes — killing only the bash leader would leave those holding the pipe
    // write ends and make the output collection below block forever.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_tree(pid: u32) {
    // On Windows the spawned process is not a job object; killing the direct
    // child is the best available approximation here.
    let _ = pid;
}

#[tauri::command]
fn run_janitor_command(
    target: String,
    command: String,
    sudo_password: Option<String>,
) -> Result<JanitorCommandResult, String> {
    let target = target.trim().to_ascii_lowercase();
    if target != "local" && target != "unraid" {
        return Err("Janitor target must be local or unraid.".to_string());
    }
    let command = command.trim();
    if command.is_empty() || command.len() > 4000 {
        return Err("Janitor command must contain 1-4000 characters.".to_string());
    }
    let sudo_password = sudo_password.filter(|value| !value.is_empty());
    let needs_sudo = command_needs_sudo(command);
    // Applies to both targets now: on unraid, a passwordless remote sudo would
    // otherwise silently block on the remote host until the timeout.
    if needs_sudo && sudo_password.is_none() {
        return Err("SUDO_PASSWORD_REQUIRED".to_string());
    }
    if let Some(reason) = guardrail_violation(command) {
        return Err(reason.to_string());
    }
    // The sudo password is embedded inside a 0700 askpass script, never in a
    // process environment variable (which every descendant would inherit and
    // any same-user process could read via /proc/<pid>/environ).
    let askpass_script = match sudo_password.as_deref() {
        Some(password) => match write_askpass_script(password) {
            Ok(path) => Some(path),
            Err(error) => return Err(error),
        },
        None => None,
    };
    let wrapped_command = if askpass_script.is_some() {
        // Force every `sudo` in the command through `-A` so it reads the password
        // via SUDO_ASKPASS instead of trying (and failing, stdin is null) to
        // prompt interactively.
        format!("sudo() {{ command sudo -A \"$@\"; }}; export -f sudo\n{command}")
    } else {
        command.to_string()
    };
    // For the unraid target with sudo, the remote command is piped as a bash
    // script over ssh stdin (`unraid-ssh.sh bash -s`): the password preamble
    // (`sudo -S -v`, which caches credentials for the session) never appears in
    // any process argv on either machine, which passing it as an ssh argument
    // would expose in the local process list.
    let remote_script_file = if target == "unraid" && askpass_script.is_some() {
        let password = sudo_password.clone().unwrap_or_default();
        let encoded = {
            const TABLE: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut encoded = String::with_capacity(password.len().div_ceil(3) * 4);
            for chunk in password.as_bytes().chunks(3) {
                let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
                let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
                encoded.push(TABLE[(n >> 18) as usize & 63] as char);
                encoded.push(TABLE[(n >> 12) as usize & 63] as char);
                encoded.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
                encoded.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
            }
            encoded
        };
        let script_path = std::env::temp_dir().join(format!(
            "iris-unraid-{}-{}.sh",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let script_content = format!(
            "printf '%s' '{encoded}' | {{ base64 -d; printf '\\n'; }} | sudo -S -p '' -v\n{command}\n"
        );
        match std::fs::write(&script_path, script_content) {
            Ok(()) => Some(script_path),
            Err(error) => {
                if let Some(path) = &askpass_script {
                    let _ = std::fs::remove_file(path);
                }
                return Err(format!("Could not prepare the remote sudo script: {error}"));
            }
        }
    } else {
        None
    };
    let mut process_builder = if target == "local" {
        #[cfg(unix)]
        {
            let mut builder = Command::new("/bin/bash");
            builder.args(["-lc", &wrapped_command]);
            builder
        }
        #[cfg(windows)]
        {
            let mut builder = Command::new("powershell");
            builder.args(["-Command", &wrapped_command]);
            builder
        }
    } else {
        #[cfg(unix)]
        {
            let mut builder = Command::new("/bin/bash");
            if remote_script_file.is_some() {
                builder.args(["/mnt/ai/handoff/unraid-ssh.sh", "bash", "-s"]);
            } else {
                builder.args(["/mnt/ai/handoff/unraid-ssh.sh", command]);
            }
            builder
        }
        #[cfg(windows)]
        {
            let mut builder = Command::new("powershell");
            builder.args(["-Command", command]);
            builder
        }
    };
    let remote_stdin = match &remote_script_file {
        Some(path) => match std::fs::File::open(path) {
            Ok(file) => Stdio::from(file),
            Err(error) => {
                if let Some(path) = &askpass_script {
                    let _ = std::fs::remove_file(path);
                }
                let _ = remote_script_file.as_ref().map(std::fs::remove_file);
                return Err(format!("Could not read the remote sudo script: {error}"));
            }
        },
        None => Stdio::null(),
    };
    process_builder.stdin(remote_stdin).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(script_path) = &askpass_script {
        process_builder.env("SUDO_ASKPASS", script_path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group so the timeout can kill the whole tree.
        process_builder.process_group(0);
    }
    let spawn_result = process_builder.spawn();
    let cleanup_askpass = || {
        if let Some(path) = &askpass_script {
            let _ = std::fs::remove_file(path);
        }
        if let Some(path) = &remote_script_file {
            let _ = std::fs::remove_file(path);
        }
    };
    let mut process = match spawn_result {
        Ok(process) => process,
        Err(error) => {
            cleanup_askpass();
            return Err(format!("Could not start Janitor command: {error}"));
        }
    };
    // Drain stdout/stderr on dedicated threads. Reading in the wait loop itself
    // would stall the poll while the child fills the 64 KiB pipe buffer; without
    // draining, any command producing more output than that would hang until the
    // deadline even though it is healthy. Each thread reports EOF via a flag so
    // the collection step can distinguish "pipes closed" from "a grandchild is
    // still holding the write end".
    let (stdout_done, stderr_done) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    fn drain_pipe(
        pipe: impl std::io::Read + Send + 'static,
        done: Arc<AtomicBool>,
    ) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut child_pipe = pipe;
            let mut chunk = [0u8; 8192];
            loop {
                match child_pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            done.store(true, Ordering::SeqCst);
            buffer
        })
    }
    let mut stdout_handle = process
        .stdout
        .take()
        .map(|pipe| drain_pipe(pipe, Arc::clone(&stdout_done)));
    let mut stderr_handle = process
        .stderr
        .take()
        .map(|pipe| drain_pipe(pipe, Arc::clone(&stderr_done)));
    let deadline = Instant::now() + Duration::from_secs(60);
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
                cleanup_askpass();
                return Err(format!("Could not inspect Janitor command: {error}"));
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            kill_process_tree(process.id());
            // SIGKILL closes every holder of the pipe write ends in the group,
            // so the drain threads reach EOF and can be joined.
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
        // The main process exited but grandchildren may still hold the pipe
        // write ends. Give well-behaved daemons a short grace period to close
        // them, then force EOF by killing the (own) process group — otherwise
        // output collection would block forever on a stray holder.
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
    let exit_code = process.try_wait().ok().flatten().and_then(|status| status.code());
    cleanup_askpass();
    let limit = 64 * 1024;
    let truncate = |bytes: Vec<u8>| {
        let text = String::from_utf8_lossy(&bytes).to_string();
        if text.len() > limit {
            format!(
                "{}\n[output truncated]",
                text.chars().take(limit).collect::<String>()
            )
        } else {
            text
        }
    };
    let mut stderr = truncate(stderr_bytes);
    if timed_out {
        stderr.push_str("\n[command timed out after 60 seconds and was stopped]");
    }
    if askpass_script.is_some() && exit_code == Some(1) && stderr.contains("incorrect password attempt") {
        stderr.push_str("\n[the sudo password was incorrect]");
    }
    Ok(JanitorCommandResult {
        target,
        exit_code,
        stdout: truncate(stdout_bytes),
        stderr,
    })
}

#[tauri::command]
fn run_janitor_diagnostic(
    target: String,
    check: String,
) -> Result<JanitorDiagnosticResult, String> {
    let check = check.trim().to_ascii_lowercase();
    let command = match check.as_str() {
        "connectivity" => "printf '%s\\n' '=== connectivity ==='; hostname; uname -srm",
        "system" => "printf '%s\\n' '=== system ==='; uptime; free -h 2>/dev/null || true",
        "storage" => "printf '%s\\n' '=== storage ==='; df -h",
        "containers" => "printf '%s\\n' '=== containers ==='; docker ps -a --format '{{.Names}}\\t{{.Status}}'",
        "crash-loops" => "printf '%s\\n' '=== crash loops ==='; docker ps -a --format '{{.Names}}\\t{{.Status}}' --filter status=exited; docker ps --format '{{.Names}}\\t{{.Status}}'",
        "full" => "printf '%s\\n' '=== connectivity ==='; hostname; uname -srm; printf '%s\\n' '=== system ==='; uptime; free -h 2>/dev/null || true; printf '%s\\n' '=== storage ==='; df -h; printf '%s\\n' '=== containers ==='; docker ps -a --format '{{.Names}}\\t{{.Status}}'; printf '%s\\n' '=== crash loops ==='; docker ps -a --format '{{.Names}}\\t{{.Status}}' --filter status=exited",
        _ => return Err("Janitor diagnostic is not supported.".to_string()),
    };
    let result = run_janitor_command(target, command.to_string(), None)?;
    Ok(JanitorDiagnosticResult {
        target: result.target,
        check,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
    })
}

fn credential_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    if provider_id.is_empty()
        || provider_id.len() > 128
        || !provider_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("Invalid provider identifier".to_string());
    }

    keyring::Entry::new("systems.iris.desktop", &format!("provider:{provider_id}"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_provider_secret(provider_id: String, secret: String) -> Result<(), String> {
    let entry = credential_entry(&provider_id)?;
    if secret.is_empty() {
        return entry.delete_credential().map_err(|error| error.to_string());
    }
    entry
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_provider_secret(provider_id: String) -> Result<Option<String>, String> {
    let entry = credential_entry(&provider_id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_provider_secret(provider_id: String) -> Result<(), String> {
    let entry = credential_entry(&provider_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
fn show_main_from_widget(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn show_widget(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.show();
        let _ = widget.unminimize();
    }
    Ok(())
}

#[tauri::command]
fn toggle_widget(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(widget) = app.get_webview_window("widget") {
        if widget.is_visible().unwrap_or(false) {
            let _ = widget.hide();
        } else {
            let _ = widget.show();
            let _ = widget.unminimize();
        }
    }
    Ok(())
}

#[tauri::command]
fn start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_webkit_renderer();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(workspace::WorkspaceState::default())
        .manage(mcp::McpStdioState::default())
        .invoke_handler(tauri::generate_handler![
            inspect_host,
            inspect_host_metrics,
            provider_http_get_json,
            run_janitor_command,
            run_janitor_diagnostic,
            janitor_projectcockpit_request,
            set_provider_secret,
            get_provider_secret,
            delete_provider_secret,
            show_main_window,
            hide_main_window,
            show_main_from_widget,
            show_widget,
            toggle_widget,
            start_drag,
            workspace::mount_workspace,
            workspace::unmount_workspace,
            workspace::list_workspace,
            workspace::read_workspace_file,
            workspace::search_workspace,
            workspace::create_workspace_directory,
            workspace::write_workspace_file,
            workspace::move_workspace_entry,
            workspace::delete_workspace_entry,
            workspace::apply_workspace_patch,
            workspace::workspace_git_status,
            catalog::fetch_directory,
            mcp::mcp_request,
            mcp::mcp_stdio_request,
            mcp::mcp_close_stdio_session,
            oauth::oauth_get,
            oauth::oauth_post_json,
            oauth::oauth_post_form,
            oauth::oauth_start_listener,
            oauth::oauth_await_callback,
            oauth::oauth_cancel_listener
        ])
        .setup(|app| {
            // Automatically ensure localStorage is synchronized between dev and release origins
            if let Ok(data_dir) = app.path().app_local_data_dir() {
                let ls_dir = data_dir.join("localstorage");
                let dev_db = ls_dir.join("http_localhost_1420.localstorage");
                let rel_db = ls_dir.join("tauri_localhost_0.localstorage");
                if dev_db.exists() && (!rel_db.exists() || rel_db.metadata().map(|m| m.len() < 1024).unwrap_or(true)) {
                    let _ = std::process::Command::new("sqlite3")
                        .arg(&dev_db)
                        .arg(format!(".backup {}", rel_db.to_string_lossy()))
                        .output();
                }
            }

            let show_item = tauri::menu::MenuItem::with_id(app, "show", "Open IRIS Workspace", true, None::<&str>)?;
            let widget_item = tauri::menu::MenuItem::with_id(app, "widget", "Toggle Desktop Widget", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit IRIS", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_item, &widget_item, &quit_item])?;

            let tray = tauri::tray::TrayIconBuilder::with_id("iris-main-tray")
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "widget" => {
                        if let Some(widget) = app.get_webview_window("widget") {
                            if widget.is_visible().unwrap_or(false) {
                                let _ = widget.hide();
                            } else {
                                let _ = widget.show();
                                let _ = widget.unminimize();
                            }
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Crucial: keep tray alive in memory for the entire app lifetime so it never prematurely drops
            std::mem::forget(tray);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    let app = window.app_handle();
                    if let Some(widget) = app.get_webview_window("widget") {
                        let _ = widget.show();
                        let _ = widget.unminimize();
                    }
                } else if window.label() == "widget" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running IRIS");
}

#[cfg(test)]
mod janitor_tests {
    use super::{command_needs_sudo, guardrail_violation, normalize_for_guardrail};

    #[test]
    fn normalize_collapses_whitespace_and_quotes() {
        assert_eq!(normalize_for_guardrail("Docker\t \"rm\"  \n nginx"), "docker rm nginx");
        assert_eq!(normalize_for_guardrail("docker    rm"), "docker rm");
    }

    #[test]
    fn guardrail_blocks_protected_service_destruction() {
        for command in [
            "docker rm -f nginx-proxy-manager-official",
            "docker  rm  nginx-proxy-manager-official",
            "docker\tcontainer\trm nginx-proxy-manager-official",
            "docker stop hermes-agent",
            "docker system prune -af",
            "echo rm; docker rmi litellm-proxy",
        ] {
            assert!(
                guardrail_violation(command).is_some(),
                "should block: {command}"
            );
        }
    }

    #[test]
    fn guardrail_blocks_quoting_bypass() {
        assert!(guardrail_violation("\"docker \"\"rm\" nginx-proxy-manager-official").is_some());
    }

    #[test]
    fn guardrail_blocks_network_changes_but_not_readonly_diagnostics() {
        assert!(guardrail_violation("ip addr show").is_none());
        assert!(guardrail_violation("ip route list").is_none());
        assert!(guardrail_violation("nmcli device status").is_none());
        assert!(guardrail_violation("ip addr add 192.168.1.5 dev eth0").is_some());
        assert!(guardrail_violation("nmcli connection modify eth0 ipv4.dns 1.1.1.1").is_some());
        assert!(guardrail_violation("ip route flush all").is_some());
    }

    #[test]
    fn guardrail_allows_ordinary_janitor_work() {
        assert!(guardrail_violation("docker ps -a --format '{{.Names}}'").is_none());
        assert!(guardrail_violation("df -h && uptime").is_none());
    }

    #[test]
    fn sudo_detection_matches_standalone_word() {
        assert!(command_needs_sudo("sudo docker ps"));
        assert!(command_needs_sudo("echo ok && sudo -v"));
        assert!(!command_needs_sudo("sudoku --solve"));
        assert!(!command_needs_sudo("docker ps"));
    }
}
