use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthHttpResponse {
    status: u16,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Authorization servers are named by the MCP server being connected to, not by IRIS, so the address
/// cannot be pinned to an allowlist. It is still held to HTTPS with no credentials in the authority.
fn validate(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "That authorization address is not a valid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("An authorization server must be reached over HTTPS.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("An authorization address must not carry credentials.".to_string());
    }
    Ok(parsed)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // A redirect could forward the client secret or refresh token to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("IRIS could not start the authorization request: {error}"))
}

async fn read_body(response: reqwest::Response) -> Result<OAuthHttpResponse, String> {
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("The authorization server response could not be read: {error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The authorization server response was too large to read.".to_string());
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "The authorization server returned a non-UTF-8 response.".to_string())?;
    Ok(OAuthHttpResponse { status, body })
}

#[tauri::command]
pub async fn oauth_get(url: String) -> Result<OAuthHttpResponse, String> {
    let target = validate(&url)?;
    let response = client()?
        .get(target)
        .header("accept", "application/json")
        .header("mcp-protocol-version", "2025-06-18")
        .send()
        .await
        .map_err(|error| format!("The authorization server could not be reached: {error}"))?;
    read_body(response).await
}

#[tauri::command]
pub async fn oauth_post_json(url: String, body: String) -> Result<OAuthHttpResponse, String> {
    let target = validate(&url)?;
    let response = client()?
        .post(target)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("The authorization server could not be reached: {error}"))?;
    read_body(response).await
}

#[tauri::command]
pub async fn oauth_post_form(
    url: String,
    form: HashMap<String, String>,
) -> Result<OAuthHttpResponse, String> {
    let target = validate(&url)?;
    let response = client()?
        .post(target)
        .header("accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("The authorization server could not be reached: {error}"))?;
    read_body(response).await
}

/// Binds a loopback port for the redirect. The port is chosen by the OS and returned so the caller
/// can build a redirect URI that matches exactly what will be listening.
#[tauri::command]
pub fn oauth_start_listener() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("IRIS could not open a local port for the sign-in: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    LISTENERS
        .lock()
        .map_err(|_| "The sign-in listener state was poisoned.".to_string())?
        .insert(port, listener);
    Ok(port)
}

static LISTENERS: std::sync::LazyLock<std::sync::Mutex<HashMap<u16, TcpListener>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn respond(mut stream: TcpStream, message: &str) {
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>IRIS</title>\
         <body style=\"font-family:system-ui;background:#faf8f3;color:#24231f;display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"text-align:center\"><h1 style=\"font-weight:620\">{message}</h1>\
         <p style=\"color:#77736b\">You can close this tab and return to IRIS.</p></div>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        page.len(),
        page
    );
    let _ = stream.flush();
}

fn parse_callback_target(port: u16, target: &str) -> Result<Option<OAuthCallback>, String> {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{target}"))
        .map_err(|_| "The sign-in returned an unreadable address.".to_string())?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let mut params: HashMap<String, String> = HashMap::new();
    for (key, value) in url.query_pairs() {
        params.insert(key.to_string(), value.to_string());
    }
    if !params.contains_key("code") && !params.contains_key("error") {
        return Ok(None);
    }
    Ok(Some(OAuthCallback {
        code: params.get("code").cloned(),
        state: params.get("state").cloned(),
        error: params.get("error").cloned(),
        error_description: params.get("error_description").cloned(),
    }))
}

/// Waits for the browser to come back with the authorization code. Blocking is fine here because
/// Tauri runs commands off the UI thread, and the wait is bounded.
#[tauri::command]
pub fn oauth_await_callback(port: u16) -> Result<OAuthCallback, String> {
    let listener = LISTENERS
        .lock()
        .map_err(|_| "The sign-in listener state was poisoned.".to_string())?
        .remove(&port)
        .ok_or_else(|| "That sign-in is no longer waiting for a response.".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            return Err("The sign-in was not completed in time.".to_string());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).ok();
                let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
                let mut request_line = String::new();
                reader
                    .read_line(&mut request_line)
                    .map_err(|error| format!("The sign-in response could not be read: {error}"))?;
                let target = request_line.split_whitespace().nth(1).unwrap_or("/");
                let Some(callback) = parse_callback_target(port, target)? else {
                    respond(stream, "IRIS is still waiting for sign-in");
                    continue;
                };
                let failed = callback.error.is_some();
                respond(
                    stream,
                    if failed {
                        "Sign-in failed"
                    } else {
                        "Signed in to IRIS"
                    },
                );
                return Ok(callback);
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(format!("The sign-in listener failed: {error}")),
        }
    }
}

#[tauri::command]
pub fn oauth_cancel_listener(port: u16) -> Result<(), String> {
    LISTENERS
        .lock()
        .map_err(|_| "The sign-in listener state was poisoned.".to_string())?
        .remove(&port);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_callback_target, validate};

    #[test]
    fn requires_https_without_credentials() {
        assert!(validate("https://gmail.mintmcp.com/token").is_ok());
        assert!(validate("http://gmail.mintmcp.com/token").is_err());
        assert!(validate("https://user:pass@gmail.mintmcp.com/token").is_err());
        assert!(validate("not a url").is_err());
    }

    #[test]
    fn accepts_only_a_real_oauth_callback() {
        assert!(parse_callback_target(5123, "/favicon.ico")
            .unwrap()
            .is_none());
        assert!(parse_callback_target(5123, "/callback?state=only")
            .unwrap()
            .is_none());
        let callback = parse_callback_target(5123, "/callback?code=abc&state=expected")
            .unwrap()
            .unwrap();
        assert_eq!(callback.code.as_deref(), Some("abc"));
        assert_eq!(callback.state.as_deref(), Some("expected"));
    }
}
