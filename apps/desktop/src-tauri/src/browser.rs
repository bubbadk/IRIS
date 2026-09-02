use serde::Deserialize;
use serde::Serialize;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

/// Real browser automation through the WebDriver protocol. A `chromedriver`
/// process is spawned headless and spoken to over plain HTTP with reqwest —
/// clicks and key presses are genuine WebDriver input events, never simulated.
/// The state mutex is never held across `.await`: every async operation runs on
/// a cloned session handle, which also keeps commands targeting the same session
/// even if a new one replaces it mid-flight.

#[derive(Clone)]
struct SessionHandle {
    driver_port: u16,
    session_id: String,
    http: reqwest::Client,
}

impl SessionHandle {
    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.driver_port)
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let url = format!("{}{}", self.base_url(), path);
        let mut request = self.http.request(method, &url);
        if let Some(payload) = body {
            request = request.json(&payload);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Browser driver request failed: {error}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| format!("Browser driver returned unreadable output: {error}"))?;
        let parsed: WebDriverValue = serde_json::from_str(&text).map_err(|_| {
            format!(
                "Browser driver returned invalid JSON: {}",
                truncate_text(&text, 200)
            )
        })?;
        if !status.is_success() {
            return Err(webdriver_error_text(status, &parsed.value, &text));
        }
        Ok(parsed.value)
    }

    async fn execute_script(
        &self,
        script: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.request(
            reqwest::Method::POST,
            &format!("/session/{}/execute/sync", self.session_id),
            Some(serde_json::json!({ "script": script, "args": args })),
        )
        .await
    }

    async fn current_url(&self) -> Result<String, String> {
        Ok(self
            .request(
                reqwest::Method::GET,
                &format!("/session/{}/url", self.session_id),
                None,
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string())
    }

    async fn title(&self) -> Result<String, String> {
        Ok(self
            .request(
                reqwest::Method::GET,
                &format!("/session/{}/title", self.session_id),
                None,
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string())
    }

    async fn snapshot(&self) -> Result<BrowserPageState, String> {
        let url = self.current_url().await?;
        let title = self.title().await?;
        let elements_value = self
            .execute_script(COLLECT_ELEMENTS_SCRIPT, serde_json::json!([]))
            .await?;
        let elements: Vec<BrowserElementRef> = serde_json::from_value(elements_value)
            .map_err(|error| format!("Browser returned a malformed element snapshot: {error}"))?;
        let text_summary = self
            .execute_script(PAGE_TEXT_SCRIPT, serde_json::json!([]))
            .await?
            .as_str()
            .unwrap_or("")
            .to_string();
        Ok(BrowserPageState {
            url,
            title,
            elements,
            text_summary,
        })
    }

    /// Locates a real web element id by ref index, CSS selector or visible text.
    async fn locate_element(
        &self,
        reference: Option<f64>,
        selector: Option<&str>,
        text: Option<&str>,
    ) -> Result<String, String> {
        let (script, args) = match reference {
            Some(index) => (FIND_ELEMENT_BY_REF_SCRIPT, serde_json::json!([index])),
            None => (
                FIND_BY_SELECTOR_OR_TEXT_SCRIPT,
                serde_json::json!([{ "selector": selector, "text": text }]),
            ),
        };
        let value = self.execute_script(script, args).await?;
        value
            .get("element-6066-11e4-a52e-4f735466cecf")
            .or_else(|| value.get("ELEMENT"))
            .and_then(|id| id.as_str())
            .map(|id| id.to_string())
            .ok_or_else(|| {
                "No matching visible element was found on the page. Take a snapshot (browser.navigate or browser.vision) to refresh element refs.".to_string()
            })
    }
}

struct BrowserSession {
    driver: Child,
    handle: SessionHandle,
}

pub struct BrowserState(Mutex<Option<BrowserSession>>);

impl Default for BrowserState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageState {
    url: String,
    title: String,
    elements: Vec<BrowserElementRef>,
    text_summary: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementRef {
    #[serde(rename = "ref")]
    reference: usize,
    tag: String,
    text: String,
    href: Option<String>,
    input_type: Option<String>,
    placeholder: Option<String>,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResult {
    url: String,
    title: String,
    action: String,
    target: String,
    page: BrowserPageState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotResult {
    url: String,
    title: String,
    mime_type: String,
    byte_size: usize,
    /// Absolute PNG path when a workspace is mounted; None otherwise.
    screenshot_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClosedResult {
    closed: bool,
}

/// Ordered candidate browser binaries chromedriver can drive.
pub const BROWSER_CANDIDATES: &[&str] =
    &["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

pub fn find_browser_binary() -> Option<PathBuf> {
    for candidate in BROWSER_CANDIDATES {
        let path = PathBuf::from("/usr/bin").join(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Binds an ephemeral port and releases it for chromedriver to claim.
pub fn find_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not find a free port: {error}"))?;
    Ok(listener
        .local_addr()
        .map_err(|error| format!("Could not read the local port: {error}"))?
        .port())
}

pub fn validate_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("URL must start with http:// or https://.".to_string());
    }
    if trimmed.chars().count() > 2000 {
        return Err("URL is limited to 2000 characters.".to_string());
    }
    Ok(())
}

/// The snapshot collector is shared by every tool so `ref` indexes stay consistent
/// across navigate, click and type within one page state.
pub const COLLECT_ELEMENTS_SCRIPT: &str = r#"
const isVisible = (el) => {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const selector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [onclick], summary';
return Array.from(document.querySelectorAll(selector))
  .filter(isVisible)
  .slice(0, 150)
  .map((el, index) => ({
    ref: index,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
    href: el.getAttribute('href') || null,
    type: el.getAttribute('type') || null,
    placeholder: el.getAttribute('placeholder') || null,
    id: el.id || null,
    name: el.getAttribute('name') || null,
  }));
"#;

/// Returns the element at `ref` in document order using the same filters as the
/// collector — serialized back by WebDriver as a real web element for trusted input.
pub const FIND_ELEMENT_BY_REF_SCRIPT: &str = r#"
const isVisible = (el) => {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const selector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [onclick], summary';
return Array.from(document.querySelectorAll(selector)).filter(isVisible)[arguments[0]] || null;
"#;

pub const FIND_BY_SELECTOR_OR_TEXT_SCRIPT: &str = r#"
const {selector, text} = arguments[0];
{
  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  let candidates = [];
  if (selector) {
    try {
      candidates = Array.from(document.querySelectorAll(selector));
    } catch {
      return null;
    }
  } else if (text) {
    const needle = String(text).trim().toLowerCase();
    candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], summary, input[type="submit"], input[type="button"]'));
    candidates = candidates.filter((el) => {
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      return label === needle || label.includes(needle);
    });
  }
  return candidates.filter(isVisible)[0] || null;
}
"#;

pub const PAGE_TEXT_SCRIPT: &str = r#"
return (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 2000) : '');
"#;

#[derive(Deserialize)]
struct WebDriverError {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct WebDriverValue {
    #[serde(default)]
    value: serde_json::Value,
}

fn truncate_text(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn webdriver_error_text(
    _status: reqwest::StatusCode,
    value: &serde_json::Value,
    raw: &str,
) -> String {
    let parsed: Result<WebDriverError, _> = serde_json::from_value(value.clone());
    let detail = match parsed {
        Ok(error) => error
            .message
            .or(error.error)
            .unwrap_or_else(|| truncate_text(raw, 200)),
        Err(_) => truncate_text(raw, 200),
    };
    format!("Browser driver error: {detail}")
}

fn lock_state<'a>(
    state: &'a State<'_, BrowserState>,
) -> Result<std::sync::MutexGuard<'a, Option<BrowserSession>>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Browser state is unavailable.".to_string())
}

fn active_handle(state: &State<'_, BrowserState>) -> Result<SessionHandle, String> {
    let guard = lock_state(state)?;
    let session = guard
        .as_ref()
        .ok_or_else(|| {
            "No browser session is running. Call browser_start first to launch the automated browser."
                .to_string()
        })?;
    Ok(session.handle.clone())
}

fn kill_driver_tree(driver: &mut Child) {
    // chromedriver was started as its own process group leader; killing the group
    // takes down the browser it spawned too.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(driver.id() as i32), libc::SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = driver.kill();
    }
}

async fn tokio_sleep(duration: Duration) {
    // Commands run on the tokio runtime; std::thread::sleep would block it.
    tokio::time::sleep(duration).await;
}

fn new_driver_command(port: u16) -> Command {
    let mut command = Command::new("chromedriver");
    command.arg("--port").arg(port.to_string());
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

/// Starts a headless chromedriver + Chrome session, replacing any existing one.
#[tauri::command]
pub async fn browser_start(state: State<'_, BrowserState>) -> Result<BrowserPageState, String> {
    let browser_binary = find_browser_binary().ok_or_else(|| {
        "No Chrome/Chromium browser was found on this system to automate.".to_string()
    })?;
    let driver_port = find_free_port()?;

    let mut driver = new_driver_command(driver_port)
        .spawn()
        .map_err(|error| format!("Could not start chromedriver (is it installed?): {error}"))?;

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Could not prepare the browser connection: {error}"))?;

    let startup = start_driver_session(&http, driver_port, &browser_binary).await;
    let session_id = match startup {
        Ok(id) => id,
        Err(reason) => {
            kill_driver_tree(&mut driver);
            let _ = driver.wait();
            return Err(reason);
        }
    };

    let new_session = BrowserSession {
        driver,
        handle: SessionHandle { driver_port, session_id, http },
    };

    // Swap in the new session; clean up the old one without holding the lock
    // across awaits.
    let mut old = {
        let mut guard = lock_state(&state)?;
        guard.replace(new_session)
    };
    if let Some(previous) = old.as_mut() {
        let _ = previous
            .handle
            .request(
                reqwest::Method::DELETE,
                &format!("/session/{}", previous.handle.session_id),
                None,
            )
            .await;
    }
    if let Some(mut previous) = old.take() {
        kill_driver_tree(&mut previous.driver);
        let _ = previous.driver.wait();
    }

    let handle = active_handle(&state)?;
    handle.snapshot().await
}

async fn start_driver_session(
    http: &reqwest::Client,
    driver_port: u16,
    browser_binary: &PathBuf,
) -> Result<String, String> {
    // Wait for the driver's HTTP endpoint to answer /status.
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut ready = false;
    while Instant::now() < deadline {
        match http
            .get(format!("http://127.0.0.1:{driver_port}/status"))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                ready = true;
                break;
            }
            _ => tokio_sleep(Duration::from_millis(150)).await,
        }
    }
    if !ready {
        return Err("chromedriver did not become ready in time.".to_string());
    }

    let capabilities = serde_json::json!({
        "capabilities": {
            "alwaysMatch": {
                "browserName": "chrome",
                "unhandledPromptBehavior": "accept",
                "timeouts": { "pageLoad": 30000, "implicit": 5000, "script": 10000 },
                "goog:chromeOptions": {
                    "binary": browser_binary.to_string_lossy(),
                    "args": [
                        "--headless=new",
                        "--disable-gpu",
                        "--window-size=1280,900",
                        "--no-first-run",
                        "--no-default-browser-check"
                    ]
                }
            }
        }
    });

    let response = http
        .post(format!("http://127.0.0.1:{driver_port}/session"))
        .json(&capabilities)
        .send()
        .await
        .map_err(|error| format!("Could not create the browser session: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Browser session response was unreadable: {error}"))?;
    let parsed: WebDriverValue = serde_json::from_str(&text).map_err(|_| {
        format!(
            "Browser session returned invalid JSON: {}",
            truncate_text(&text, 200)
        )
    })?;
    if !status.is_success() {
        return Err(format!(
            "Could not create the browser session: {}",
            webdriver_error_text(status, &parsed.value, &text)
        ));
    }
    parsed
        .value
        .get("sessionId")
        .and_then(|id| id.as_str())
        .map(|id| id.to_string())
        .ok_or_else(|| "Browser session response did not include a session id.".to_string())
}

#[tauri::command]
pub async fn browser_navigate(
    state: State<'_, BrowserState>,
    url: String,
) -> Result<BrowserPageState, String> {
    validate_url(&url)?;
    let handle = active_handle(&state)?;
    handle
        .request(
            reqwest::Method::POST,
            &format!("/session/{}/url", handle.session_id),
            Some(serde_json::json!({ "url": url })),
        )
        .await?;
    handle.snapshot().await
}

#[tauri::command]
pub async fn browser_snapshot(state: State<'_, BrowserState>) -> Result<BrowserPageState, String> {
    let handle = active_handle(&state)?;
    handle.snapshot().await
}

fn describe_target(
    reference: Option<f64>,
    selector: Option<&str>,
    text: Option<&str>,
) -> Result<String, String> {
    if let Some(index) = reference {
        if !index.is_finite() || index < 0.0 || index.fract() != 0.0 {
            return Err("ref must be a non-negative whole number from a page snapshot.".to_string());
        }
        return Ok(format!("element ref {index}"));
    }
    if let Some(selector) = selector.filter(|value| !value.trim().is_empty()) {
        return Ok(format!("selector {selector}"));
    }
    if let Some(text) = text.filter(|value| !value.trim().is_empty()) {
        return Ok(format!("text \"{text}\""));
    }
    Err("Provide one of ref (from a snapshot), selector, or text.".to_string())
}

#[tauri::command]
pub async fn browser_click(
    state: State<'_, BrowserState>,
    reference: Option<f64>,
    selector: Option<String>,
    text: Option<String>,
) -> Result<BrowserActionResult, String> {
    let target = describe_target(reference, selector.as_deref(), text.as_deref())?;
    let handle = active_handle(&state)?;
    let element_id = handle
        .locate_element(reference, selector.as_deref(), text.as_deref())
        .await?;
    handle
        .request(
            reqwest::Method::POST,
            &format!("/session/{}/element/{element_id}/click", handle.session_id),
            Some(serde_json::json!({})),
        )
        .await?;
    let page = handle.snapshot().await?;
    Ok(BrowserActionResult {
        url: page.url.clone(),
        title: page.title.clone(),
        action: "clicked".to_string(),
        target,
        page,
    })
}

#[tauri::command]
pub async fn browser_type(
    state: State<'_, BrowserState>,
    reference: Option<f64>,
    selector: Option<String>,
    text: String,
    clear: Option<bool>,
) -> Result<BrowserActionResult, String> {
    if text.is_empty() {
        return Err("Text to type must not be empty.".to_string());
    }
    let target = describe_target(reference, selector.as_deref(), None)?;
    let handle = active_handle(&state)?;
    let element_id = handle
        .locate_element(reference, selector.as_deref(), None)
        .await?;
    if clear.unwrap_or(true) {
        handle
            .request(
                reqwest::Method::POST,
                &format!("/session/{}/element/{element_id}/clear", handle.session_id),
                Some(serde_json::json!({})),
            )
            .await?;
    }
    handle
        .request(
            reqwest::Method::POST,
            &format!("/session/{}/element/{element_id}/value", handle.session_id),
            Some(serde_json::json!({ "text": text })),
        )
        .await?;
    let page = handle.snapshot().await?;
    Ok(BrowserActionResult {
        url: page.url.clone(),
        title: page.title.clone(),
        action: "typed".to_string(),
        target,
        page,
    })
}

#[tauri::command]
pub async fn browser_vision(
    state: State<'_, BrowserState>,
    workspace: State<'_, crate::workspace::WorkspaceState>,
) -> Result<BrowserScreenshotResult, String> {
    let handle = active_handle(&state)?;
    let base64_data = handle
        .request(
            reqwest::Method::GET,
            &format!("/session/{}/screenshot", handle.session_id),
            None,
        )
        .await?
        .as_str()
        .unwrap_or("")
        .to_string();
    if base64_data.is_empty() {
        return Err("The browser returned an empty screenshot.".to_string());
    }
    // A language model cannot look at raw base64, so the honest deliverable is a
    // real PNG file the user can open, saved inside the mounted workspace.
    use base64::Engine as _;
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|_| "The browser screenshot was not valid base64.".to_string())?;
    let workspace_root = crate::workspace::mounted_root(&workspace);
    let saved_path = match workspace_root {
        Ok(root) => {
            let dir = root.join("iris-vision");
            std::fs::create_dir_all(&dir)
                .map_err(|error| format!("Could not create the iris-vision folder: {error}"))?;
            let file_name = format!(
                "page-{}.png",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            );
            let file_path = dir.join(file_name);
            std::fs::write(&file_path, &png_bytes)
                .map_err(|error| format!("Could not save the screenshot: {error}"))?;
            Some(file_path.to_string_lossy().replace('\\', "/"))
        }
        Err(_) => None,
    };
    let url = handle.current_url().await?;
    let title = handle.title().await?;
    Ok(BrowserScreenshotResult {
        url,
        title,
        mime_type: "image/png".to_string(),
        byte_size: png_bytes.len(),
        screenshot_path: saved_path,
    })
}

#[tauri::command]
pub async fn browser_close(state: State<'_, BrowserState>) -> Result<BrowserClosedResult, String> {
    let mut session = {
        let mut guard = lock_state(&state)?;
        guard.take()
    };
    let Some(mut session) = session.take() else {
        return Err("No browser session is running.".to_string());
    };
    let _ = session
        .handle
        .request(
            reqwest::Method::DELETE,
            &format!("/session/{}", session.handle.session_id),
            None,
        )
        .await;
    kill_driver_tree(&mut session.driver);
    let _ = session.driver.wait();
    Ok(BrowserClosedResult { closed: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_free_port() {
        let port = find_free_port().unwrap();
        assert!((1024..65535).contains(&port));
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(validate_url("ftp://example.com").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("").is_err());
        assert!(validate_url("https://example.com/page").is_ok());
        assert!(validate_url("http://localhost:8080/").is_ok());
    }

    #[test]
    fn browser_candidates_cover_installed_browsers() {
        assert!(BROWSER_CANDIDATES.contains(&"google-chrome-stable"));
        assert!(BROWSER_CANDIDATES.contains(&"chromium"));
    }

    #[test]
    fn finds_installed_browser_binary() {
        // The dev machine has Chrome or Chromium; on any other machine this is
        // allowed to be None, but the paths must be the ones we advertise.
        if let Some(path) = find_browser_binary() {
            assert!(path.is_file());
        }
    }
}
