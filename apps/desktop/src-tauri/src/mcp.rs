use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpResponse {
    status: u16,
    content_type: String,
    session_id: Option<String>,
    authenticate: Option<String>,
    location: Option<String>,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioRequest {
    command: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
    payload: String,
}

pub struct McpStdioState {
    sessions: Mutex<HashMap<String, Child>>,
    next_id: AtomicU64,
}

impl Default for McpStdioState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

fn validate_stdio(request: &McpStdioRequest) -> Result<(), String> {
    if request.command.is_empty()
        || request.command.len() > 240
        || request.command.contains(['\0', '\n', '\r'])
    {
        return Err("The local MCP command is invalid.".to_string());
    }
    if request.args.len() > 100
        || request
            .args
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > 2000 || arg.contains(['\0', '\n', '\r']))
    {
        return Err("The local MCP command arguments are invalid.".to_string());
    }
    if request.env.as_ref().is_some_and(|env| {
        env.len() > 64
            || env.iter().any(|(key, value)| {
                !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    || key.is_empty()
                    || value.is_empty()
                    || value.len() > 2000
                    || value.contains(['\0', '\n', '\r'])
            })
    }) {
        return Err("The local MCP environment is invalid.".to_string());
    }
    if request.payload.len() > MAX_RESPONSE_BYTES {
        return Err("The MCP request is too large.".to_string());
    }
    Ok(())
}

fn prepare_stdio_command(request: &McpStdioRequest) -> Command {
    let mut command = Command::new(&request.command);
    command
        .args(&request.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SHELL",
        "TMPDIR",
        "XDG_RUNTIME_DIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "NODE_PATH",
    ] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    if let Some(env) = &request.env {
        command.envs(env);
    }
    command
}

/// Starts a local server only for this explicit connection request. Process execution is native-only;
/// tools discovered from it still enter IRIS's normal deny-by-default permission path.
#[tauri::command]
pub fn mcp_stdio_request(
    state: tauri::State<'_, McpStdioState>,
    session_id: Option<String>,
    request: McpStdioRequest,
) -> Result<McpHttpResponse, String> {
    validate_stdio(&request)?;
    let session_id = session_id.filter(|id| !id.trim().is_empty());
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "IRIS could not lock local MCP sessions.")?;
    let id = session_id
        .unwrap_or_else(|| format!("stdio-{}", state.next_id.fetch_add(1, Ordering::Relaxed)));
    if !sessions.contains_key(&id) {
        let mut command = prepare_stdio_command(&request);
        sessions.insert(
            id.clone(),
            command
                .spawn()
                .map_err(|error| format!("IRIS could not start the local MCP server: {error}"))?,
        );
    }
    let child = sessions
        .get_mut(&id)
        .ok_or("IRIS lost the local MCP session.")?;
    child
        .stdin
        .as_mut()
        .ok_or("IRIS could not open local MCP stdin.")?
        .write_all(format!("{}\n", request.payload).as_bytes())
        .map_err(|error| format!("IRIS could not write to the local MCP server: {error}"))?;
    child
        .stdin
        .as_mut()
        .unwrap()
        .flush()
        .map_err(|error| format!("IRIS could not flush local MCP stdin: {error}"))?;
    // Read the reply off the locked session so a hung server cannot block every other MCP
    // session forever: take the pipe, release the lock, and read under a deadline in a helper
    // thread. On timeout the server is killed and the detached read unblocks on the closed pipe.
    let mut stdout = child
        .stdout
        .take()
        .ok_or("IRIS could not open local MCP stdout.")?;
    drop(sessions);

    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut one = [0_u8; 1];
        loop {
            match stdout.read(&mut one) {
                Ok(0) => break,
                Ok(_) => {
                    if one[0] == b'\n' {
                        break;
                    }
                    if bytes.len() >= MAX_RESPONSE_BYTES {
                        let _ = sender.send(Err("size".to_string()));
                        return;
                    }
                    bytes.push(one[0]);
                }
                Err(error) => {
                    let _ = sender.send(Err(format!("read:{error}")));
                    return;
                }
            }
        }
        let _ = sender.send(Ok((stdout, bytes)));
    });

    let (stdout, bytes) = match receiver.recv_timeout(REQUEST_TIMEOUT) {
        Ok(Ok(result)) => result,
        Ok(Err(reason)) => {
            let mut sessions = state
                .sessions
                .lock()
                .map_err(|_| "IRIS could not lock local MCP sessions.")?;
            if let Some(mut child) = sessions.remove(&id) {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(if reason == "size" {
                "The local MCP server response exceeded the size IRIS will read.".to_string()
            } else {
                format!(
                    "IRIS could not read the local MCP server: {}",
                    reason.strip_prefix("read:").unwrap_or(&reason)
                )
            });
        }
        Err(_) => {
            let mut sessions = state
                .sessions
                .lock()
                .map_err(|_| "IRIS could not lock local MCP sessions.")?;
            if let Some(mut child) = sessions.remove(&id) {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err("The local MCP server did not respond in time.".to_string());
        }
    };

    // Return the pipe to the session so the next request can reuse the running server.
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "IRIS could not lock local MCP sessions.")?;
        if let Some(child) = sessions.get_mut(&id) {
            child.stdout = Some(stdout);
        }
    }

    let body = String::from_utf8(bytes)
        .map_err(|_| "The local MCP server returned a non-UTF-8 response.".to_string())?;
    Ok(McpHttpResponse {
        status: 200,
        content_type: "application/json".to_string(),
        session_id: Some(id),
        authenticate: None,
        location: None,
        body,
    })
}

#[tauri::command]
pub fn mcp_close_stdio_session(
    state: tauri::State<'_, McpStdioState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "IRIS could not lock local MCP sessions.")?;
    if let Some(mut child) = sessions.remove(&session_id) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// The address comes from the user, so it cannot be pinned to an allowlist the way the skill
/// catalog is. It is still constrained: TLS everywhere except loopback, and no credentials smuggled
/// through the authority.
fn validate(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "That MCP server address is not a valid URL.".to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_string();
    if host.is_empty() {
        return Err("That MCP server address has no host.".to_string());
    }
    let loopback = is_loopback(&host);
    match parsed.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err("An MCP server must use HTTPS, or HTTP only on localhost.".to_string());
        }
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Put credentials in the token field, not in the server address.".to_string());
    }
    Ok(parsed)
}

fn safe_redirect(from: &reqwest::Url, to: &reqwest::Url) -> bool {
    from.scheme() == to.scheme()
        && from.host_str() == to.host_str()
        && from.port_or_known_default() == to.port_or_known_default()
        && to.username().is_empty()
        && to.password().is_none()
}

fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many MCP redirects");
        }
        match attempt.previous().last() {
            Some(previous) if safe_redirect(previous, attempt.url()) => attempt.follow(),
            _ => attempt.stop(),
        }
    })
}

#[tauri::command]
pub async fn mcp_request(
    url: String,
    payload: String,
    token: Option<String>,
    session_id: Option<String>,
) -> Result<McpHttpResponse, String> {
    let target = validate(&url)?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // Canonical path redirects are common, but credentials never cross an origin boundary.
        .redirect(redirect_policy())
        .build()
        .map_err(|error| format!("IRIS could not start the MCP request: {error}"))?;

    let mut request = client
        .post(target)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .body(payload);
    if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(session) = session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        request = request.header("mcp-session-id", session);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("The MCP server could not be reached: {error}"))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let challenges = response
        .headers()
        .get_all(reqwest::header::WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>();
    let authenticate = (!challenges.is_empty()).then(|| challenges.join(", "));
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("The MCP server response could not be read: {error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The MCP server response exceeded the size IRIS will read.".to_string());
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "The MCP server returned a non-UTF-8 response.".to_string())?;

    Ok(McpHttpResponse {
        status,
        content_type,
        session_id: session,
        authenticate,
        location,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::{safe_redirect, validate};

    #[test]
    fn accepts_https_anywhere_and_http_only_on_loopback() {
        assert!(validate("https://mcp.example.com/mcp").is_ok());
        assert!(validate("http://localhost:3000/mcp").is_ok());
        assert!(validate("http://127.0.0.1:8080/sse").is_ok());
    }

    #[test]
    fn rejects_plain_http_to_the_network() {
        assert!(validate("http://mcp.example.com/mcp").is_err());
    }

    #[test]
    fn rejects_credentials_in_the_address_and_malformed_input() {
        assert!(validate("https://user:pass@mcp.example.com/mcp").is_err());
        assert!(validate("not a url").is_err());
        assert!(validate("ftp://mcp.example.com/mcp").is_err());
    }

    #[test]
    fn follows_only_same_origin_redirects_without_credentials() {
        let source = reqwest::Url::parse("https://api.example.com/mcp").unwrap();
        assert!(safe_redirect(
            &source,
            &reqwest::Url::parse("https://api.example.com/mcp/").unwrap()
        ));
        assert!(!safe_redirect(
            &source,
            &reqwest::Url::parse("https://login.example.com/mcp/").unwrap()
        ));
        assert!(!safe_redirect(
            &source,
            &reqwest::Url::parse("http://api.example.com/mcp/").unwrap()
        ));
        assert!(!safe_redirect(
            &source,
            &reqwest::Url::parse("https://user:secret@api.example.com/mcp/").unwrap()
        ));
    }

    #[test]
    fn stdio_command_inherits_path_and_applies_custom_env() {
        use super::{prepare_stdio_command, McpStdioRequest};
        use std::collections::HashMap;

        let mut custom_env = HashMap::new();
        custom_env.insert("CUSTOM_VAR".to_string(), "test_value".to_string());

        let req = McpStdioRequest {
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            env: Some(custom_env),
            payload: "{}".to_string(),
        };

        let cmd = prepare_stdio_command(&req);
        let envs: HashMap<_, _> = cmd.get_envs().filter_map(|(k, v)| {
            v.map(|val| (k.to_string_lossy().to_string(), val.to_string_lossy().to_string()))
        }).collect();

        assert_eq!(envs.get("CUSTOM_VAR"), Some(&"test_value".to_string()));
        if std::env::var("PATH").is_ok() {
            assert!(envs.contains_key("PATH"));
        }
    }
}
