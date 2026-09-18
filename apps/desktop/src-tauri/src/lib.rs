mod scheduler_lock;
mod process_identity;
use crate::process_output::{output_text, read_bounded};
use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

mod background_service;
mod browser;
mod browser_proxy;
mod catalog;
mod document_export;
mod mcp;
mod oauth;
mod process_output;
mod repository;
mod sandbox_shell;
mod shell_isolation;
mod workspace;
mod workspace_undo;
mod web_policy;
mod web_read;

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
        cpu_count: std::thread::available_parallelism()
            .ok()
            .map(|value| value.get()),
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
async fn provider_http_get_json(
    url: String,
    token: Option<String>,
) -> Result<HttpGetResult, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "That address is not a valid URL.".to_string())?;
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
    if let Some(token) = token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
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
    command
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .any(|word| word == "sudo")
}

/// Collapse whitespace runs and strip quote/backslash characters so guardrail
/// matching cannot be bypassed with `docker    rm`, tab separators, or
/// `"docker ""rm"`-style quoting. Token-aware checks then work on the result.
fn normalize_for_guardrail(command: &str) -> String {
    let stripped: String = command
        .chars()
        .map(|c| {
            if c == '"' || c == '\'' || c == '\\' {
                ' '
            } else {
                c
            }
        })
        .collect();
    stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
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
    if destructive
        .iter()
        .any(|operation| lowered.contains(operation))
        && protected_targets
            .iter()
            .any(|target| lowered.contains(target))
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
        " add ",
        " del ",
        " delete ",
        " replace ",
        " flush ",
        " set ",
        " modify ",
    ];
    if network_objects
        .iter()
        .any(|object| lowered.contains(object))
        && mutators.iter().any(|mutator| padded.contains(mutator))
    {
        return Some("Janitor guardrail blocked a network interface or route change.");
    }
    None
}

/// A high-entropy name token for a temporary secret file.
///
/// A predictable temporary path lets another local user pre-create it, and a predictable *reusable*
/// path is what makes symlink substitution worth attempting. The token carries 128 bits from the OS
/// entropy source; the fallback below is still unique per process and call, and the `O_EXCL` create
/// in [`create_private_secret_file`] refuses to reuse or follow any path that already exists, so the
/// random name is defence in depth rather than the only protection.
fn secret_temp_token() -> String {
    #[cfg(unix)]
    {
        use std::io::Read;
        let mut bytes = [0u8; 16];
        if std::fs::File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .is_ok()
        {
            return bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        }
    }
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, counter)
}

/// Creates a brand-new temporary file and writes `contents` into it, owner-only from the first byte.
///
/// The security contract this establishes (H3):
///
/// * On Unix the permission bits are handed to `open(2)` at creation, so there is no interval —
///   not even a single syscall — in which the secret exists with group or other access. Writing
///   first and calling `chmod`/`set_permissions` afterwards is explicitly NOT done: that leaves a
///   TOCTOU window, and it is what the Unraid remote-script path did before this helper existed.
/// * `umask` can only clear permission bits, never add them, so a permissive umask cannot widen the
///   result; a restrictive one can only make the file stricter (`0600 & ~umask <= 0600`).
/// * `create_new(true)` supplies `O_CREAT | O_EXCL`, which fails rather than following a symlink or
///   overwriting a path another user prepared, and a fresh unpredictable name is retried on
///   collision.
///
/// Cleanup is deliberately *not* part of this contract: `SIGKILL` runs no cleanup, so
/// confidentiality must hold even if the file is never removed.
fn create_private_secret_file(
    prefix: &str,
    mode: u32,
    contents: &str,
) -> Result<std::path::PathBuf, String> {
    let directory = std::env::temp_dir();
    let mut last_error: Option<std::io::Error> = None;
    for _ in 0..16 {
        let path = directory.join(format!("{prefix}-{}.sh", secret_temp_token()));
        match create_private_secret_file_at(&path, mode, contents) {
            Ok(()) => return Ok(path),
            // The name already exists (perhaps planted by another user). O_EXCL means it was not
            // followed or overwritten; take a fresh name instead.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "no unique temporary name was available: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no attempt was possible".to_string())
    ))
}

/// Creates exactly `path` and writes `contents` into it, refusing to touch anything that already
/// exists. Split out from the retry loop above so the symlink/pre-creation contract can be proven
/// directly against a known path without weakening the production naming.
fn create_private_secret_file_at(
    path: &std::path::Path,
    mode: u32,
    contents: &str,
) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(not(unix))]
    let _ = mode;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // Unix only: owner access is applied by the open itself. Non-Unix has no group/other permission
    // bits; the file stays in the per-user temporary directory, and `create_new` still guarantees a
    // pre-existing or symlinked path is never written through.
    #[cfg(unix)]
    options.mode(mode);
    let mut file = options.open(path)?;
    if let Err(error) = file.write_all(contents.as_bytes()).and_then(|()| file.flush()) {
        // A partially written secret file is still a secret file: remove it.
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

/// Best-effort removal of one sudo secret artifact.
///
/// Every cleanup site goes through this function. It is best effort by design: confidentiality is
/// provided by how the file was created, never by whether it was deleted, because a force-killed
/// process runs no cleanup at all.
fn remove_secret_artifact(path: &Option<std::path::PathBuf>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
fn write_askpass_script(password: &str) -> Result<std::path::PathBuf, String> {
    // The password is embedded base64-encoded inside an owner-only script instead of a process
    // environment variable: environments are inherited by every descendant process and readable via
    // /proc/<pid>/environ, while this file is readable only by the owning user and is deleted after
    // the run. 0700 (not 0600) because `sudo` executes it.
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(password.len().div_ceil(3) * 4);
    for chunk in password.as_bytes().chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        encoded.push(TABLE[(n >> 18) as usize & 63] as char);
        encoded.push(TABLE[(n >> 12) as usize & 63] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    create_private_secret_file(
        "iris-askpass",
        0o700,
        &format!("#!/bin/sh\nprintf '%s' '{encoded}' | base64 -d\n"),
    )
    .map_err(|error| format!("Could not prepare the sudo password helper: {error}"))
}

#[cfg(not(unix))]
fn write_askpass_script(_password: &str) -> Result<std::path::PathBuf, String> {
    Err("SUDO askpass is only supported on Unix systems.".to_string())
}

/// The Unraid remote sudo preamble plus the requested command.
fn remote_sudo_script_contents(encoded_password: &str, command: &str) -> String {
    // `sudo -S -v` caches the credential for the session, then the command runs. The password is
    // piped in, so it never appears in any process argv on either machine.
    format!(
        "printf '%s' '{encoded_password}' | {{ base64 -d; printf '\\n'; }} | sudo -S -p '' -v\n{command}\n"
    )
}

/// Writes the Unraid remote sudo script.
///
/// H3: this file carries the base64-encoded sudo password, so it is a secret file and is created
/// owner-only (0600) from the first byte under an unpredictable name. It was previously written
/// with `std::fs::write`, which produced `0644` under a `0022` umask and survived `SIGKILL`
/// readable by every local user.
fn write_remote_sudo_script(
    encoded_password: &str,
    command: &str,
) -> Result<std::path::PathBuf, String> {
    create_private_secret_file(
        "iris-unraid",
        0o600,
        &remote_sudo_script_contents(encoded_password, command),
    )
    .map_err(|error| format!("Could not prepare the remote sudo script: {error}"))
}

#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    // The child was started as its own process group leader (process_group(0)),
    // so killing -pgid takes down wrappers and grandchildren that inherited the
    // pipes — killing only the bash leader would leave those holding the pipe
    // write ends and make the output collection below block forever.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
pub(crate) fn kill_process_tree(pid: u32) {
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
    //
    // This is effectively a Unix-only path: `askpass_script` can only be `Some` where
    // `write_askpass_script` succeeds, and on non-Unix that function returns an error, so the branch
    // below is unreachable there.
    let remote_script_file = if target == "unraid" && askpass_script.is_some() {
        let password = sudo_password.clone().unwrap_or_default();
        let encoded = {
            const TABLE: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut encoded = String::with_capacity(password.len().div_ceil(3) * 4);
            for chunk in password.as_bytes().chunks(3) {
                let b = [
                    chunk[0],
                    *chunk.get(1).unwrap_or(&0),
                    *chunk.get(2).unwrap_or(&0),
                ];
                let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
                encoded.push(TABLE[(n >> 18) as usize & 63] as char);
                encoded.push(TABLE[(n >> 12) as usize & 63] as char);
                encoded.push(if chunk.len() > 1 {
                    TABLE[(n >> 6) as usize & 63] as char
                } else {
                    '='
                });
                encoded.push(if chunk.len() > 2 {
                    TABLE[n as usize & 63] as char
                } else {
                    '='
                });
            }
            encoded
        };
        // The script is created owner-only 0600 from the first byte; it carries the password.
        match write_remote_sudo_script(&encoded, command) {
            Ok(script_path) => Some(script_path),
            Err(error) => {
                remove_secret_artifact(&askpass_script);
                return Err(error);
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
                remove_secret_artifact(&askpass_script);
                remove_secret_artifact(&remote_script_file);
                return Err(format!("Could not read the remote sudo script: {error}"));
            }
        },
        None => Stdio::null(),
    };
    process_builder
        .stdin(remote_stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        remove_secret_artifact(&askpass_script);
        remove_secret_artifact(&remote_script_file);
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
    let (stdout_done, stderr_done) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
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
    let exit_code = process
        .try_wait()
        .ok()
        .flatten()
        .and_then(|status| status.code());
    cleanup_askpass();

    let mut stderr = output_text(stderr_bytes);
    if timed_out {
        stderr.push_str("\n[command timed out after 60 seconds and was stopped]");
    }
    if askpass_script.is_some()
        && exit_code == Some(1)
        && stderr.contains("incorrect password attempt")
    {
        stderr.push_str("\n[the sudo password was incorrect]");
    }
    Ok(JanitorCommandResult {
        target,
        exit_code,
        stdout: output_text(stdout_bytes),
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
        .manage(scheduler_lock::SchedulerLock::default())
        .manage(workspace::WorkspaceState::default())
        .manage(browser::BrowserState::default())
        .manage(mcp::McpStdioState::default())
        .manage(document_export::DocumentExportState::default())
        .invoke_handler(tauri::generate_handler![
            process_identity::process_instance_nonce,
            process_identity::process_is_alive,
            process_identity::process_own_pid,
            repository::repository_initialize,
            repository::repository_snapshot,
            repository::repository_commit,
            inspect_host,
            inspect_host_metrics,
            provider_http_get_json,
            web_read::web_read_public_page,
            run_janitor_command,
            run_janitor_diagnostic,
            sandbox_shell::run_workspace_shell_command,
            shell_isolation::workspace_shell_isolation_status,
            browser::browser_start,
            browser::browser_inspect,
            browser::browser_take_control,
            browser::browser_return_control,
            browser::browser_close_from_ui,
            browser::browser_navigate,
            browser::browser_switch_tab,
            browser::browser_snapshot,
            browser::browser_click,
            browser::browser_type,
            browser::browser_vision,
            browser::browser_close,
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
            workspace::read_project_check_file,
            scheduler_lock::acquire_schedule_owner,
            background_service::background_service_status,
            background_service::install_background_service,
            background_service::remove_background_service,
            workspace::search_workspace,
            workspace::create_workspace_directory,
            workspace::write_workspace_file,
            workspace::move_workspace_entry,
            workspace::delete_workspace_entry,
            workspace::apply_workspace_patch,
            document_export::begin_document_export,
            document_export::save_document_export,
            workspace::workspace_git_status,
            workspace_undo::list_workspace_restore_points,
            workspace_undo::preview_workspace_restore_point,
            workspace_undo::restore_workspace_file,
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
            let background_service =
                std::env::args().any(|argument| argument == "--background-service");
            // Scheduler ownership is an optional subsystem: its failure degrades queued execution
            // instead of making the interactive application unstartable. The frontend reports the
            // real reason when it asks for ownership.
            match scheduler_lock::evaluate_schedule_ownership(app) {
                scheduler_lock::OwnershipOutcome::Owned => {}
                scheduler_lock::OwnershipOutcome::HeldByAnotherProcess => {
                    eprintln!(
                        "IRIS: queued execution stays with the IRIS process that already owns it."
                    );
                }
                scheduler_lock::OwnershipOutcome::Unavailable(reason) => {
                    eprintln!("IRIS: scheduled execution is unavailable: {reason}");
                }
            }
            if background_service
                && !scheduler_lock::has_schedule_owner(app).unwrap_or(false)
            {
                // The interactive IRIS instance owns queued execution. That is the expected
                // steady state, not a failure. Exit the process cleanly (status 0) so systemd
                // sees success and never enters a restart loop; returning from `setup` alone
                // would leave the event loop running with nothing to do.
                eprintln!(
                    "IRIS background runtime: queued execution is already owned by another IRIS \
process. Exiting without taking over."
                );
                app.handle().exit(background_service::OWNERSHIP_CONFLICT_EXIT_CODE);
                return Ok(());
            }
            if background_service {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            let show_item = tauri::menu::MenuItem::with_id(
                app,
                "show",
                "Open IRIS Workspace",
                true,
                None::<&str>,
            )?;
            let widget_item = tauri::menu::MenuItem::with_id(
                app,
                "widget",
                "Toggle Desktop Widget",
                true,
                None::<&str>,
            )?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit IRIS", true, None::<&str>)?;
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
        assert_eq!(
            normalize_for_guardrail("Docker\t \"rm\"  \n nginx"),
            "docker rm nginx"
        );
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

/**
 * H3 regression coverage — sudo secret temporary files.
 *
 * Pre-fix, the Unraid remote sudo script (base64-encoded password) was written with
 * `std::fs::write`, which produced `0644` under `umask 0022` and survived `SIGKILL` readable by every
 * local user. These tests drive the *production* writers, not a copy of them, and they use sentinel
 * values only: no real password, no network, nothing beyond the local temp directory.
 */
#[cfg(all(test, unix))]
mod sudo_secret_file_tests {
    use super::{
        create_private_secret_file_at, remove_secret_artifact, run_janitor_command,
        write_askpass_script, write_remote_sudo_script,
    };
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    const SENTINEL_PASSWORD: &str = "SENTINEL_SUDO_PASSWORD_2I1";
    const SENTINEL_ENCODED: &str = "U0VOVElORUxfU1VET19QQVNTV09SRF8ySTE=";
    const SECRET_PREFIXES: [&str; 2] = ["iris-askpass-", "iris-unraid-"];

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path)
            .expect("secret file exists")
            .permissions()
            .mode()
            & 0o7777
    }

    /// Every sudo secret artifact currently sitting in the process temp directory.
    fn secret_artifacts_in_temp_dir() -> Vec<PathBuf> {
        let directory = std::env::temp_dir();
        let mut found: Vec<PathBuf> = std::fs::read_dir(&directory)
            .expect("temp directory is readable")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .map(|name| {
                        let name = name.to_string_lossy();
                        SECRET_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
                    })
                    .unwrap_or(false)
            })
            .collect();
        found.sort();
        found
    }

    /// Case A: the file the production writer really creates is owner-only.
    #[test]
    fn remote_sudo_script_is_owner_only_and_carries_the_encoded_secret() {

        let _guard = lock_sudo_temp();
        let path = write_remote_sudo_script(SENTINEL_ENCODED, "echo janitor-fixture")
            .expect("remote sudo script is created");

        assert_eq!(
            mode_of(&path),
            0o600,
            "the sudo secret file must be owner read/write only, never group/other readable"
        );

        let contents = std::fs::read_to_string(&path).expect("secret file is readable by its owner");
        assert!(contents.contains(SENTINEL_ENCODED), "the file really carries the secret");
        assert!(
            !contents.contains(SENTINEL_PASSWORD),
            "only the encoded form is written, never the plaintext"
        );
        assert!(contents.ends_with("echo janitor-fixture
"));

        // Case A/naming: the name is not the old `pid + ~0 nanos` pattern, and two files in the same
        // process cannot collide.
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("iris-unraid-"), "unexpected name shape: {name}");
        let second = write_remote_sudo_script(SENTINEL_ENCODED, "echo janitor-fixture")
            .expect("second remote sudo script is created");
        assert_ne!(path, second, "temporary secret names must not be reused");

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&second).unwrap();
    }

    /// Case A: the askpass sibling keeps its executable bit and is owner-only too.
    #[test]
    fn askpass_script_is_executable_owner_only_and_never_plaintext() {

        let _guard = lock_sudo_temp();
        let path = write_askpass_script(SENTINEL_PASSWORD).expect("askpass script is created");

        assert_eq!(mode_of(&path), 0o700, "sudo must execute it, nobody else may read it");
        let contents = std::fs::read_to_string(&path).expect("askpass script is readable by owner");
        assert!(
            !contents.contains(SENTINEL_PASSWORD),
            "the askpass script must not contain the plaintext password"
        );

        std::fs::remove_file(&path).unwrap();
    }

    /// Case C: an existing file or a planted symlink is never written through.
    #[test]
    fn refuses_to_write_through_a_pre_existing_path_or_symlink() {

        let _guard = lock_sudo_temp();
        let directory = std::env::temp_dir();
        let victim = directory.join(format!("iris-h3-victim-{}.txt", std::process::id()));
        let existing = directory.join(format!("iris-h3-existing-{}.sh", std::process::id()));
        let link = directory.join(format!("iris-h3-link-{}.sh", std::process::id()));
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_file(&existing);
        let _ = std::fs::remove_file(&link);

        std::fs::write(&victim, "attacker-visible-content").unwrap();
        std::fs::write(&existing, "pre-existing").unwrap();
        std::os::unix::fs::symlink(&victim, &link).unwrap();

        // (a) an existing regular file is not truncated or overwritten.
        assert!(
            create_private_secret_file_at(&existing, 0o600, SENTINEL_ENCODED).is_err(),
            "O_EXCL must refuse an existing path instead of overwriting it"
        );
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "pre-existing");

        // (b) a symlink is not followed: the secret never lands in the attacker's file.
        assert!(
            create_private_secret_file_at(&link, 0o600, SENTINEL_ENCODED).is_err(),
            "O_EXCL must refuse a pre-existing symlink"
        );
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "attacker-visible-content",
            "no secret byte may be written through the symlink"
        );
        assert!(
            std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "the planted symlink must still be a symlink, not a replaced regular file"
        );

        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_file(&existing);
        let _ = std::fs::remove_file(&link);
    }

    /// Case D/E: the cleanup function every production path uses really removes both artifacts, and
    /// is a no-op when they are already gone (error paths may run it twice).
    #[test]
    fn cleanup_removes_both_secret_artifacts_and_tolerates_repeats() {

        let _guard = lock_sudo_temp();
        let askpass = Some(write_askpass_script(SENTINEL_PASSWORD).unwrap());
        let remote = Some(write_remote_sudo_script(SENTINEL_ENCODED, "true").unwrap());
        assert!(askpass.as_ref().unwrap().exists());
        assert!(remote.as_ref().unwrap().exists());

        remove_secret_artifact(&askpass);
        remove_secret_artifact(&remote);

        assert!(!askpass.as_ref().unwrap().exists(), "askpass artifact must be removed");
        assert!(!remote.as_ref().unwrap().exists(), "remote artifact must be removed");
        // Idempotent: the four production cleanup call sites may overlap.
        remove_secret_artifact(&askpass);
        remove_secret_artifact(&remote);
    }

    /// Case D: the real local command path (success) leaves no secret artifact behind.
    #[test]
    fn a_completed_janitor_command_leaves_no_secret_artifact() {

        let _guard = lock_sudo_temp();
        let before = secret_artifacts_in_temp_dir();
        let result = run_janitor_command(
            "local".to_string(),
            "true".to_string(),
            Some(SENTINEL_PASSWORD.to_string()),
        )
        .expect("local janitor command runs");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(
            secret_artifacts_in_temp_dir(),
            before,
            "a completed command must not leave a sudo secret file behind"
        );
    }

    /// Case E: an ordinary failure (non-zero exit) also leaves no secret artifact behind.
    #[test]
    fn a_failing_janitor_command_leaves_no_secret_artifact() {

        let _guard = lock_sudo_temp();
        let before = secret_artifacts_in_temp_dir();
        let result = run_janitor_command(
            "local".to_string(),
            "false".to_string(),
            Some(SENTINEL_PASSWORD.to_string()),
        )
        .expect("local janitor command reports a failing command");
        assert_eq!(result.exit_code, Some(1));
        assert_eq!(
            secret_artifacts_in_temp_dir(),
            before,
            "a failing command must not leave a sudo secret file behind"
        );
    }

    /// Every test here inspects the shared process temp directory (and two of them change the
    /// process-global `umask`), so they serialize on this lock instead of perturbing each other's
    /// observations.
    static SUDO_TEMP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_sudo_temp() -> std::sync::MutexGuard<'static, ()> {
        SUDO_TEMP_LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Adversarial re-run of the Phase 2I.0 reproduction against the repaired production writers:
    /// the same representative `umask 0022`, the same two file shapes, observed directly.
    #[test]
    fn pre_fix_reproduction_under_umask_0022_is_now_owner_only() {
        let _guard = lock_sudo_temp();
        let previous = unsafe { libc::umask(0o022) };
        let askpass = write_askpass_script(SENTINEL_PASSWORD).expect("askpass script");
        let remote =
            write_remote_sudo_script(SENTINEL_ENCODED, "echo janitor-fixture").expect("remote script");
        let askpass_mode = mode_of(&askpass);
        let remote_mode = mode_of(&remote);
        let remote_contains_encoded = std::fs::read_to_string(&remote)
            .expect("remote script is readable by owner")
            .contains(SENTINEL_ENCODED);
        unsafe {
            libc::umask(previous);
        }

        println!("H3-POSTFIX-UMASK 0o022");
        println!("H3-POSTFIX-ASKPASS {} mode 0o{askpass_mode:o}", askpass.display());
        println!("H3-POSTFIX-REMOTE {} mode 0o{remote_mode:o}", remote.display());
        println!("H3-POSTFIX-REMOTE-CONTAINS-ENCODED {remote_contains_encoded}");

        assert_eq!(askpass_mode, 0o700);
        assert_eq!(remote_mode, 0o600, "pre-fix this was 0o644");
        assert_eq!(remote_mode & 0o077, 0, "no group/other bit may ever be set");
        assert!(remote_contains_encoded);

        let _ = std::fs::remove_file(&askpass);
        let _ = std::fs::remove_file(&remote);
    }

    /// The pre-fix defect was observable *while the command ran*, not only after it died. This
    /// watches the real production command path from another thread and asserts that no observed
    /// moment of the live secret file has a group or other permission bit.
    #[test]
    fn a_live_janitor_command_never_exposes_a_group_readable_secret_file() {
        let _guard = lock_sudo_temp();
        let previous = unsafe { libc::umask(0o022) };
        let before = secret_artifacts_in_temp_dir();
        let handle = std::thread::spawn(|| {
            run_janitor_command(
                "local".to_string(),
                "sleep 1".to_string(),
                Some(SENTINEL_PASSWORD.to_string()),
            )
        });

        let mut observed: Vec<(PathBuf, u32)> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline && observed.is_empty() {
            for path in secret_artifacts_in_temp_dir() {
                if before.contains(&path) || observed.iter().any(|(seen, _)| seen == &path) {
                    continue;
                }
                let mode = mode_of(&path);
                observed.push((path, mode));
            }
            if observed.is_empty() {
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        let result = handle.join().expect("command thread").expect("command runs");
        unsafe {
            libc::umask(previous);
        }

        assert_eq!(result.exit_code, Some(0));
        assert!(
            !observed.is_empty(),
            "the live secret file must be observable while the command is still running"
        );
        for (path, mode) in &observed {
            assert_eq!(
                mode & 0o077,
                0,
                "a live secret file must never be group/other readable: {} had mode 0o{mode:o}",
                path.display()
            );
        }
        assert_eq!(
            secret_artifacts_in_temp_dir(),
            before,
            "normal completion must still remove the artifact"
        );
    }

    /// Child-process fixture. `#[ignore]` keeps it out of ordinary runs; the two tests below start
    /// this exact test binary with `--exact ... --ignored` so they observe a *second* OS process,
    /// which is the only way to prove crash residual behavior truthfully.
    #[test]
    #[ignore = "child process fixture for the umask and SIGKILL residual tests"]
    fn h3_secret_file_child_fixture() {
        if std::env::var("IRIS_H3_CHILD").is_err() {
            return;
        }
        if let Ok(mask) = std::env::var("IRIS_H3_CHILD_UMASK") {
            let mask = u32::from_str_radix(&mask, 8).expect("umask is octal");
            unsafe {
                libc::umask(mask as libc::mode_t);
            }
        }

        let askpass = write_askpass_script(SENTINEL_PASSWORD).expect("child askpass script");
        let remote =
            write_remote_sudo_script(SENTINEL_ENCODED, "true").expect("child remote script");
        println!(
            "H3-CHILD-READY {} {} {} {}",
            mode_of(&askpass),
            mode_of(&remote),
            askpass.display(),
            remote.display()
        );
        std::io::stdout().flush().unwrap();

        if std::env::var("IRIS_H3_CHILD_HOLD").is_ok() {
            // Wait to be force-killed: no cleanup may run, which is exactly the crash case.
            std::thread::sleep(Duration::from_secs(120));
        }

        let _ = std::fs::remove_file(&askpass);
        let _ = std::fs::remove_file(&remote);
    }

    struct ChildFixture {
        child: std::process::Child,
        askpass_mode: u32,
        remote_mode: u32,
        askpass: PathBuf,
        remote: PathBuf,
    }

    fn spawn_secret_child(umask: Option<u32>, hold: bool) -> ChildFixture {
        let exe = std::env::current_exe().expect("test binary path is known");
        let mut command = Command::new(exe);
        command
            .args([
                "--exact",
                "sudo_secret_file_tests::h3_secret_file_child_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("IRIS_H3_CHILD", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(mask) = umask {
            command.env("IRIS_H3_CHILD_UMASK", format!("{mask:o}"));
        }
        if hold {
            command.env("IRIS_H3_CHILD_HOLD", "1");
        }

        let mut child = command.spawn().expect("child fixture starts");
        let stdout = child.stdout.take().expect("child stdout is piped");
        // Both pipes must be drained to EOF: closing the read end early makes the child's test
        // harness fail with a broken pipe instead of exiting normally.
        let (stderr_sender, stderr_receiver) = mpsc::channel::<String>();
        if let Some(mut pipe) = child.stderr.take() {
            std::thread::spawn(move || {
                use std::io::Read;
                let mut text = String::new();
                let _ = pipe.read_to_string(&mut text);
                let _ = stderr_sender.send(text);
            });
        }
        let (sender, receiver) = mpsc::channel::<Option<String>>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut reported = false;
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        if !reported {
                            let _ = sender.send(None);
                        }
                        return;
                    }
                    Ok(_) => {
                        if !reported {
                            let trimmed = line.trim().to_string();
                            if let Some(rest) = trimmed.strip_prefix("H3-CHILD-READY ") {
                                reported = true;
                                let _ = sender.send(Some(rest.to_string()));
                            }
                        }
                    }
                }
            }
        });

        let ready = match receiver.recv_timeout(Duration::from_secs(60)) {
            Ok(Some(ready)) => ready,
            other => {
                let _ = child.kill();
                let _ = child.wait();
                let child_stderr = stderr_receiver.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
                panic!("child fixture did not report its secret files: {other:?} stderr={child_stderr}");
            }
        };
        let fields: Vec<&str> = ready.split_whitespace().collect();
        assert_eq!(fields.len(), 4, "unexpected child report: {ready}");
        ChildFixture {
            child,
            askpass_mode: fields[0].parse().expect("askpass mode"),
            remote_mode: fields[1].parse().expect("remote mode"),
            askpass: PathBuf::from(fields[2]),
            remote: PathBuf::from(fields[3]),
        }
    }

    /// Case B: the most permissive possible `umask` cannot widen the creation mode. A `write` then
    /// `chmod` implementation would produce `0666` for the remote script here; creation-time mode
    /// cannot, because `umask` only clears permission bits.
    #[test]
    fn a_permissive_umask_cannot_widen_the_creation_mode() {

        let _guard = lock_sudo_temp();
        let mut fixture = spawn_secret_child(Some(0o000), false);
        assert_eq!(fixture.askpass_mode, 0o700, "askpass mode must not follow the umask");
        assert_eq!(fixture.remote_mode, 0o600, "remote secret mode must not follow the umask");
        let status = fixture.child.wait().expect("child is reaped");
        assert!(status.success(), "child fixture reported success: {status:?}");
        // The child cleaned up after itself on the normal path.
        assert!(!fixture.askpass.exists());
        assert!(!fixture.remote.exists());
    }

    /// Case F: SIGKILL cannot run cleanup, so the residual file is the only thing standing between
    /// the secret and another local user — and it must already be owner-only.
    #[test]
    fn a_force_killed_process_leaves_only_owner_readable_secret_files() {

        let _guard = lock_sudo_temp();
        let mut fixture = spawn_secret_child(None, true);
        assert_eq!(fixture.askpass_mode, 0o700);
        assert_eq!(fixture.remote_mode, 0o600);

        unsafe {
            libc::kill(fixture.child.id() as i32, libc::SIGKILL);
        }
        let status = fixture.child.wait().expect("force-killed child is reaped");
        assert!(!status.success(), "the child was killed, not exited");

        assert!(fixture.askpass.exists(), "SIGKILL leaves the askpass file behind");
        assert!(fixture.remote.exists(), "SIGKILL leaves the remote secret file behind");
        assert_eq!(
            mode_of(&fixture.askpass),
            0o700,
            "the residual askpass file must still be owner-only"
        );
        assert_eq!(
            mode_of(&fixture.remote),
            0o600,
            "the residual secret file must still be owner-only"
        );
        println!(
            "H3-POSTFIX-CRASH-RESIDUAL askpass {} mode 0o{:o} remote {} mode 0o{:o} (SIGKILL ran no cleanup)",
            fixture.askpass.display(),
            mode_of(&fixture.askpass),
            fixture.remote.display(),
            mode_of(&fixture.remote)
        );

        std::fs::remove_file(&fixture.askpass).unwrap();
        std::fs::remove_file(&fixture.remote).unwrap();
    }
}

#[cfg(test)]
mod credential_integration_tests {
    use super::*;
    #[test]
    #[ignore = "requires an unlocked OS credential store"]
    fn isolated_os_keyring_roundtrip() {
        let id = format!(
            "iris-integration-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_provider_secret(self.0.clone());
            }
        }
        let _cleanup = Cleanup(id.clone());
        let payload = r#"{"version":1,"values":{"token":"iris-dummy-integration-value"}}"#;
        set_provider_secret(id.clone(), payload.into()).expect("OS keyring write");
        // Read through a fresh Entry to verify persistence beyond the writer's lifetime.
        assert_eq!(
            get_provider_secret(id.clone())
                .expect("OS keyring read")
                .as_deref(),
            Some(payload)
        );
        delete_provider_secret(id.clone()).expect("OS keyring delete");
        assert!(get_provider_secret(id)
            .expect("OS keyring deleted read")
            .is_none());
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod updater_integration;

/**
 * H-04 regression coverage at the real Tauri level: setup-time scheduler ownership must degrade
 * instead of aborting the application. These drive the actual `setup` logic through a mock app,
 * so they prove the boot contract rather than only the lock helper.
 */
#[cfg(test)]
mod boot_resilience_tests {
    use crate::scheduler_lock::{evaluate_schedule_ownership, OwnershipOutcome, SchedulerLock};

    /**
     * Build a mock Tauri app so the setup-time ownership contract is proven at the real
     * application level, not only against the lock helper.
     */
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let context = tauri::test::mock_context(tauri::test::noop_assets());
        tauri::test::mock_builder()
            .manage(SchedulerLock::default())
            .build(context)
            .expect("the application builds")
    }

    /// An isolated lock directory that no other test in this binary can observe.
    fn isolated_lock_dir(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "iris-boot-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /** H-04 Test 1: the normal path establishes ownership during startup. */
    #[test]
    fn normal_startup_establishes_scheduler_ownership() {
        // The mock app shares the real app-data directory, so the lock may legitimately already be
        // held by the developer's running IRIS. Assert the true normal path on an isolated lock.
        let directory = isolated_lock_dir("normal");
        let mut held = None;
        assert_eq!(
            crate::scheduler_lock::attempt_ownership_for_test(&mut held, &directory),
            OwnershipOutcome::Owned
        );
        assert!(held.is_some(), "ownership must be published when acquired");
        drop(held);
        std::fs::remove_dir_all(directory).unwrap();

        // And the real startup probe on a live app always returns a truthful, non-panicking result.
        let app = mock_app();
        let outcome = evaluate_schedule_ownership(&app);
        let reports_owned = matches!(outcome, OwnershipOutcome::Owned);
        assert_eq!(
            crate::scheduler_lock::has_schedule_owner(&app).unwrap(),
            reports_owned,
            "ownership must never be reported without a real lock"
        );
    }

    /** H-04 Test 2/4: repeated probes stay truthful and never fabricate success. */
    #[test]
    fn repeated_ownership_probes_stay_truthful() {
        let app = mock_app();
        let first = evaluate_schedule_ownership(&app);
        // A second probe must agree with the first: the app reports what it truly holds.
        let second = evaluate_schedule_ownership(&app);
        assert_eq!(first, second);
        let owned = matches!(second, OwnershipOutcome::Owned);
        assert_eq!(
            crate::scheduler_lock::has_schedule_owner(&app).unwrap(),
            owned,
            "a reported owner must match the real lock state"
        );
        // An explicitly unavailable lock is never reported as owned.
        assert!(!matches!(
            OwnershipOutcome::Unavailable("filesystem error".to_string()),
            OwnershipOutcome::Owned
        ));
    }

    /**
     * H-04 Test 3: a genuinely unavailable lock surfaces as `Unavailable` while the application
     * object stays alive. The obstacle is deterministic: a directory occupies the lock path, so it
     * can never be opened as a lock file.
     */
    #[test]
    fn unavailable_lock_degrades_without_aborting_the_application() {
        let obstacle_root = std::env::temp_dir().join(format!(
            "iris-boot-resilience-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&obstacle_root).unwrap();
        let blocked = obstacle_root.join("schedule-owner.lock");
        std::fs::create_dir_all(&blocked).unwrap();

        // The application still builds and stays alive while the lock cannot be evaluated.
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = format!("iris.schedule.probe.{}", std::process::id());
        let app = tauri::test::mock_builder()
            .manage(SchedulerLock::default())
            .build(context)
            .expect("the application still builds when the lock is unavailable");

        match crate::scheduler_lock::acquire_for_test(&blocked) {
            Err(reason) => {
                assert!(!reason.is_empty(), "an unavailable lock must explain itself");
                // The decisive H-04 contract: this is a reportable value, never a process abort.
                let degraded = OwnershipOutcome::Unavailable(reason);
                assert!(!matches!(degraded, OwnershipOutcome::Owned));
            }
            Ok(None) => {}
            Ok(Some(file)) => {
                drop(file);
                panic!("a directory can never be a valid lock file");
            }
        }
        // Ownership state stays truthfully queryable after a failed attempt.
        assert!(crate::scheduler_lock::has_schedule_owner(&app).is_ok());
        std::fs::remove_dir_all(&obstacle_root).unwrap();
    }

    /** H-13: a background-service process must not treat an owned lock as a fatal setup error. */
    #[test]
    fn background_service_startup_is_not_fatal_when_the_lock_is_owned() {
        // Case A: another owner holds the lock. The worker's decision is a plain boolean and the
        // application object stays alive — no fatal setup error, no panic.
        let directory = isolated_lock_dir("bg-conflict");
        let mut blocker = None;
        assert_eq!(
            crate::scheduler_lock::attempt_ownership_for_test(&mut blocker, &directory),
            OwnershipOutcome::Owned
        );
        let mut worker = None;
        let conflict =
            crate::scheduler_lock::attempt_ownership_for_test(&mut worker, &directory);
        assert_eq!(conflict, OwnershipOutcome::HeldByAnotherProcess);
        assert!(worker.is_none(), "the worker must not claim ownership");
        drop(blocker);
        std::fs::remove_dir_all(directory).unwrap();

        // Case B: a real app object remains queryable regardless of the outcome.
        let app = mock_app();
        let owned = evaluate_schedule_ownership(&app);
        let has_owner = crate::scheduler_lock::has_schedule_owner(&app).unwrap_or(false);
        assert_eq!(matches!(owned, OwnershipOutcome::Owned), has_owner);
    }
}
