use serde::Serialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
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

#[cfg(unix)]
fn write_askpass_script() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "iris-askpass-{}-{}.sh",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    std::fs::write(&path, "#!/bin/sh\nprintf '%s' \"$IRIS_SUDO_PW\"\n")
        .map_err(|error| format!("Could not prepare the sudo password helper: {error}"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure the sudo password helper: {error}"))?;
    Ok(path)
}

#[cfg(not(unix))]
fn write_askpass_script() -> Result<std::path::PathBuf, String> {
    Err("SUDO askpass is only supported on Unix systems.".to_string())
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
    if target == "local" && command_needs_sudo(command) && sudo_password.is_none() {
        return Err("SUDO_PASSWORD_REQUIRED".to_string());
    }
    let lowered = command.to_ascii_lowercase();
    let protected_targets = [
        "nginx-proxy-manager-official",
        "unraid-cloudflared-tunnel",
        "hermes-agent",
        "litellm-proxy",
        "postgresql18",
        "mysql",
        "dockersocket",
    ];
    let destructive = ["docker stop", "docker rm", "docker rmi", "docker kill"];
    if destructive
        .iter()
        .any(|operation| lowered.contains(operation))
        && protected_targets
            .iter()
            .any(|target| lowered.contains(target))
    {
        return Err(
            "Janitor guardrail blocked a destructive command against a protected service."
                .to_string(),
        );
    }
    if ["ip addr", "ip route", "nmcli", "ifconfig"]
        .iter()
        .any(|operation| lowered.contains(operation))
        && ["set", "add", "del", "delete", "flush", "replace"]
            .iter()
            .any(|operation| lowered.contains(operation))
    {
        return Err("Janitor guardrail blocked a network interface or route change.".to_string());
    }
    // Bug this fixes: Command previously inherited stdin from the Tauri process. A `sudo`
    // inside the command would then silently block waiting for a password on whatever
    // terminal happened to launch IRIS — invisible from the GUI, and indistinguishable
    // from a hang. stdin is now always Stdio::null() so nothing can block on it; a sudo
    // password, when needed, is supplied via SUDO_ASKPASS instead (see below).
    let askpass_script = if let Some(password) = sudo_password.as_deref() {
        Some((write_askpass_script()?, password.to_string()))
    } else {
        None
    };
    let wrapped_command = if askpass_script.is_some() {
        // Force every `sudo` in the command through `-A` so it reads the password via
        // SUDO_ASKPASS instead of trying (and failing, now that stdin is null) to read
        // an interactive prompt.
        format!("sudo() {{ command sudo -A \"$@\"; }}; export -f sudo\n{command}")
    } else {
        command.to_string()
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
            builder.args(["/mnt/ai/handoff/unraid-ssh.sh", command]);
            builder
        }
        #[cfg(windows)]
        {
            let mut builder = Command::new("powershell");
            builder.args(["-Command", command]);
            builder
        }
    };
    process_builder.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some((script_path, password)) = &askpass_script {
        process_builder
            .env("SUDO_ASKPASS", script_path)
            .env("IRIS_SUDO_PW", password);
    }
    let spawn_result = process_builder.spawn();
    let cleanup_askpass = || {
        if let Some((script_path, _)) = &askpass_script {
            let _ = std::fs::remove_file(script_path);
        }
    };
    let mut process = match spawn_result {
        Ok(process) => process,
        Err(error) => {
            cleanup_askpass();
            return Err(format!("Could not start Janitor command: {error}"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let timed_out = loop {
        match process.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) => {}
            Err(error) => {
                cleanup_askpass();
                return Err(format!("Could not inspect Janitor command: {error}"));
            }
        }
        if Instant::now() >= deadline {
            if let Err(error) = process.kill() {
                cleanup_askpass();
                return Err(format!("Could not stop Janitor command: {error}"));
            }
            break true;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = match process.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            cleanup_askpass();
            return Err(format!("Could not collect Janitor command output: {error}"));
        }
    };
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
    let mut stderr = truncate(output.stderr);
    if timed_out {
        stderr.push_str("\n[command timed out after 60 seconds and was stopped]");
    }
    if askpass_script.is_some() && output.status.code() == Some(1) && stderr.contains("incorrect password attempt") {
        stderr.push_str("\n[the sudo password was incorrect]");
    }
    Ok(JanitorCommandResult {
        target,
        exit_code: output.status.code(),
        stdout: truncate(output.stdout),
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
