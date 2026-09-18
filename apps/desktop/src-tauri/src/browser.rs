use crate::browser_proxy::NavigationProxy;
use crate::web_policy::{normalize_host, parse_public_url, parse_web_url, preflight_public_url};
use serde::Deserialize;
use serde::Serialize;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::State;

/// Real browser automation through the WebDriver protocol. A `chromedriver`
/// process drives a visible or headless browser and is spoken to over plain HTTP with reqwest —
/// clicks and key presses are genuine WebDriver input events, never simulated.
/// The state mutex is never held across `.await`: every async operation runs on
/// a cloned session handle, which also keeps commands targeting the same session
/// even if a new one replaces it mid-flight.
///
/// Destination policy is enforced in two independent places, both backed by
/// [`crate::web_policy`]: [`NavigationProxy`] is the browser's only route to the network and
/// validates every request and redirect hop, while every command here re-checks the URL it is
/// about to open and the page it is about to read. A page that ends up on a forbidden address —
/// because a redirect or a link click put it there — is torn down before any of its content is
/// returned to the model.

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

    async fn window_handle(&self) -> Result<String, String> {
        Ok(self
            .request(
                reqwest::Method::GET,
                &format!("/session/{}/window", self.session_id),
                None,
            )
            .await?
            .as_str()
            .unwrap_or("")
            .to_string())
    }

    async fn window_handles(&self) -> Result<Vec<String>, String> {
        serde_json::from_value(
            self.request(
                reqwest::Method::GET,
                &format!("/session/{}/window/handles", self.session_id),
                None,
            )
            .await?,
        )
        .map_err(|error| format!("Browser returned invalid tab information: {error}"))
    }

    async fn snapshot(&self) -> Result<BrowserPageState, String> {
        let url = self.current_url().await?;
        let title = self.title().await?;
        let elements_value = self
            .execute_script(
                COLLECT_ELEMENTS_SCRIPT,
                serde_json::json!([SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::SeqCst) * 1000]),
            )
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
    visible: bool,
    handle: SessionHandle,
    /// The enforcement proxy lives exactly as long as the session it protects.
    _proxy: NavigationProxy,
}

impl Drop for BrowserSession {
    fn drop(&mut self) {
        kill_driver_tree(&mut self.driver);
        let _ = self.driver.wait();
    }
}

pub struct BrowserState(
    Mutex<Option<BrowserSession>>,
    tokio::sync::Mutex<()>,
    AtomicBool,
    AtomicU64,
);
static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

impl Default for BrowserState {
    fn default() -> Self {
        Self(
            Mutex::new(None),
            tokio::sync::Mutex::new(()),
            AtomicBool::new(false),
            AtomicU64::new(0),
        )
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    id: String,
    active: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementRef {
    #[serde(rename = "ref")]
    reference: usize,
    tag: String,
    text: String,
    href: Option<String>,
    #[serde(rename = "type")]
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
pub const BROWSER_CANDIDATES: &[&str] = &[
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
];

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

/// Chrome's own blank page is the only non-web destination IRIS allows, because it is where a
/// session starts and where a quarantined page is parked. Everything else must be public http(s).
fn is_internal_blank_page(url: &str) -> bool {
    matches!(url.trim(), "about:blank" | "data:,")
}

/// True when the session's own policy was explicitly relaxed for a test harness. The proxy only
/// reports this in test builds, so a release build always reports false.
fn session_trusts_host(state: &BrowserState, host: &str) -> bool {
    lock_state(state)
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .map(|session| session._proxy.trusts_host(host))
        })
        .unwrap_or(false)
}

/// Validates one destination against the shared [`crate::web_policy`]. Used both before a
/// navigation is dispatched and on the URL a navigation actually landed on.
async fn validate_destination(state: &BrowserState, url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || is_internal_blank_page(trimmed) {
        return Ok(());
    }
    let host = parse_web_url(trimmed)
        .ok()
        .and_then(|url| url.host_str().map(normalize_host))
        .unwrap_or_default();
    if !host.is_empty() && session_trusts_host(state, &host) {
        return Ok(());
    }
    preflight_public_url(trimmed).await.map(|_| ())
}

/// Parks the browser on a blank page and invalidates element refs, so a page that ended up on a
/// forbidden address can never be read through a later snapshot.
async fn quarantine_page(handle: &SessionHandle) {
    let _ = handle
        .request(
            reqwest::Method::POST,
            &format!("/session/{}/url", handle.session_id),
            Some(serde_json::json!({ "url": "about:blank" })),
        )
        .await;
    let _ = handle
        .execute_script("window.__irisElementSnapshot = new Map();", serde_json::json!([]))
        .await;
}

/// The read gate: called immediately before any page content is returned to the caller. A page
/// that a redirect, a link click or a scripted navigation put on a forbidden address is torn down
/// first, so its content never leaves the browser.
async fn enforce_page_destination(state: &BrowserState, handle: &SessionHandle) -> Result<(), String> {
    let url = handle.current_url().await?;
    match validate_destination(state, &url).await {
        Ok(()) => Ok(()),
        Err(reason) => {
            quarantine_page(handle).await;
            Err(reason)
        }
    }
}

/// The pre-navigation gate for URLs a caller supplied directly.
pub async fn validate_url(state: &BrowserState, url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.chars().count() > 2000 {
        return Err("URL is limited to 2000 characters.".to_string());
    }
    // Scheme, host, reserved host names and embedded credentials come from the one policy module.
    let parsed = parse_web_url(trimmed)?;
    let host = parsed.host_str().map(normalize_host).unwrap_or_default();
    // Then the address-level rule. `session_trusts_host` is false in every release build, so this
    // always runs outside the test harness.
    if host.is_empty() || !session_trusts_host(state, &host) {
        parse_public_url(trimmed)?;
    }
    validate_destination(state, trimmed).await
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
const refs = new Map();
window.__irisElementSnapshot = refs;
const offset = arguments[0];
return Array.from(document.querySelectorAll(selector))
  .filter(isVisible)
  .slice(0, 150)
  .map((el, index) => { const ref = offset + index; refs.set(ref, el); return ({
    ref,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
    href: el.getAttribute('href') || null,
    type: el.getAttribute('type') || null,
    placeholder: el.getAttribute('placeholder') || null,
    id: el.id || null,
    name: el.getAttribute('name') || null,
  }); });
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
const element = window.__irisElementSnapshot?.get(arguments[0]);
return element && element.isConnected && isVisible(element) ? element : null;
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
    state: &'a BrowserState,
) -> Result<std::sync::MutexGuard<'a, Option<BrowserSession>>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Browser state is unavailable.".to_string())
}

fn raw_handle(state: &BrowserState) -> Result<SessionHandle, String> {
    let guard = lock_state(state)?;
    let session = guard.as_ref().ok_or_else(|| {
        "No browser session is running. Call browser_start first to launch the automated browser."
            .to_string()
    })?;
    Ok(session.handle.clone())
}

async fn automated_guard<'a>(
    state: &'a BrowserState,
) -> Result<tokio::sync::MutexGuard<'a, ()>, String> {
    let epoch = state.3.load(Ordering::SeqCst);
    if state.2.load(Ordering::SeqCst) {
        return Err("Browser is under your control. Agent actions are paused until you return control in Browser.".into());
    }
    guard_at_epoch(state, epoch).await
}
async fn guard_at_epoch(
    state: &BrowserState,
    epoch: u64,
) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
    let guard = state.1.lock().await;
    if state.2.load(Ordering::SeqCst) || state.3.load(Ordering::SeqCst) != epoch {
        return Err("Browser control changed while this action was waiting. Take a fresh snapshot before trying again.".into());
    }
    Ok(guard)
}
fn active_handle(state: &BrowserState) -> Result<SessionHandle, String> {
    if state.2.load(Ordering::SeqCst) {
        return Err("Browser is under your control. Agent actions are paused until you return control in Browser.".into());
    }
    raw_handle(state)
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
    command.arg(format!("--port={port}"));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

/// Starts a visible Chrome session by default. Never silently replace an existing session.
#[tauri::command]
pub async fn browser_start(
    state: State<'_, BrowserState>,
    visible: Option<bool>,
) -> Result<BrowserPageState, String> {
    let _operation = automated_guard(&state).await?;
    if lock_state(&state)?.is_some() {
        return Err(
            "A browser session is already running. Close it explicitly before starting another."
                .into(),
        );
    }
    let visible = visible.unwrap_or(true);
    let browser_binary = find_browser_binary().ok_or_else(|| {
        "No Chrome/Chromium browser was found on this system to automate.".to_string()
    })?;
    let driver_port = find_free_port()?;
    // The session cannot reach the network except through this proxy, and the proxy validates and
    // pins every destination with the shared policy. A session without it is not created at all.
    let proxy = NavigationProxy::start()?;

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Could not prepare the browser connection: {error}"))?;

    let mut driver = new_driver_command(driver_port)
        .spawn()
        .map_err(|error| format!("Could not start chromedriver (is it installed?): {error}"))?;

    let startup = start_driver_session(&http, driver_port, &browser_binary, visible, &proxy).await;
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
        visible,
        handle: SessionHandle {
            driver_port,
            session_id,
            http,
        },
        _proxy: proxy,
    };

    // The operation gate and existing-session check guarantee this is a new session.
    *lock_state(&state)? = Some(new_session);

    let handle = active_handle(&state)?;
    handle.snapshot().await
}

async fn start_driver_session(
    http: &reqwest::Client,
    driver_port: u16,
    browser_binary: &PathBuf,
    visible: bool,
    proxy: &NavigationProxy,
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

    let mut browser_args = vec![
        "--window-size=1280,900".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
    ];
    if !visible {
        browser_args.push("--headless=new".to_string());
    }
    browser_args.extend(proxy.chrome_args());
    let capabilities = serde_json::json!({
        "capabilities": {
            "alwaysMatch": {
                "browserName": "chrome",
                "unhandledPromptBehavior": "ignore",
                "timeouts": { "pageLoad": 30000, "implicit": 5000, "script": 10000 },
                "goog:chromeOptions": {
                    "binary": browser_binary.to_string_lossy(),
                    "args": browser_args
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
    navigate_impl(&state, url).await
}

/// The navigation path itself, callable without a Tauri `State` so the live policy tests exercise
/// the production code path instead of a copy of it.
async fn navigate_impl(state: &BrowserState, url: String) -> Result<BrowserPageState, String> {
    let _operation = automated_guard(state).await?;
    // Deny a forbidden destination before any network access is attempted.
    validate_url(state, &url).await?;
    let handle = active_handle(state)?;
    handle
        .request(
            reqwest::Method::POST,
            &format!("/session/{}/url", handle.session_id),
            Some(serde_json::json!({ "url": url })),
        )
        .await?;
    // A redirect can land somewhere the initial URL policy allowed but the destination policy
    // does not; the page is torn down before it is read.
    enforce_page_destination(&state, &handle).await?;
    handle.snapshot().await
}

#[tauri::command]
pub async fn browser_switch_tab(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserPageState, String> {
    let _operation = automated_guard(&state).await?;
    if tab_id.trim().is_empty() || tab_id.len() > 512 {
        return Err("Choose a valid browser tab.".to_string());
    }
    let handle = active_handle(&state)?;
    let known = handle.window_handles().await?;
    if !known.iter().any(|candidate| candidate == &tab_id) {
        return Err("That browser tab is no longer open. Refresh the browser view.".to_string());
    }
    handle
        .request(
            reqwest::Method::POST,
            &format!("/session/{}/window", handle.session_id),
            Some(serde_json::json!({ "handle": tab_id })),
        )
        .await?;
    // Switching to a tab loads whatever address that tab already holds.
    enforce_page_destination(&state, &handle).await?;
    handle.snapshot().await
}

/// The read path shared by the snapshot command and the live policy tests: a page that is not on a
/// permitted destination is quarantined before any of its content is returned.
async fn read_page(state: &BrowserState) -> Result<BrowserPageState, String> {
    let handle = active_handle(state)?;
    enforce_page_destination(state, &handle).await?;
    handle.snapshot().await
}

#[tauri::command]
pub async fn browser_snapshot(state: State<'_, BrowserState>) -> Result<BrowserPageState, String> {
    let _operation = automated_guard(&state).await?;
    read_page(&state).await
}

fn describe_target(
    reference: Option<f64>,
    selector: Option<&str>,
    text: Option<&str>,
) -> Result<String, String> {
    if let Some(index) = reference {
        if !index.is_finite() || index < 0.0 || index.fract() != 0.0 {
            return Err(
                "ref must be a non-negative whole number from a page snapshot.".to_string(),
            );
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
    let _operation = automated_guard(&state).await?;
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
    // A click can follow a link or run script that navigates; treat the landing page as untrusted.
    enforce_page_destination(&state, &handle).await?;
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
    let _operation = automated_guard(&state).await?;
    if text.is_empty() || text.chars().count() > 5000 {
        return Err("Text to type must contain 1 to 5000 characters.".to_string());
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
    // Submitting a field can navigate; treat the landing page as untrusted.
    enforce_page_destination(&state, &handle).await?;
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
    let _operation = automated_guard(&state).await?;
    let handle = active_handle(&state)?;
    // Never capture a page that is sitting on a forbidden address.
    enforce_page_destination(&state, &handle).await?;
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
    let _operation = automated_guard(&state).await?;
    let _handle = active_handle(&state)?;
    let mut session = {
        let mut guard = lock_state(&state)?;
        guard.take()
    };
    let Some(session) = session.take() else {
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
    drop(session);
    Ok(BrowserClosedResult { closed: true })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInspection {
    running: bool,
    visible: bool,
    user_control: bool,
    page: Option<BrowserPageState>,
    screenshot: Option<String>,
    tabs: Vec<BrowserTab>,
}
async fn inspect_session(state: &BrowserState) -> Result<BrowserInspection, String> {
    let visible = match lock_state(state)?.as_ref() {
        Some(session) => session.visible,
        None => {
            return Ok(BrowserInspection {
                running: false,
                visible: false,
                user_control: false,
                page: None,
                screenshot: None,
                tabs: Vec::new(),
            })
        }
    };
    let handle = raw_handle(state)?;
    // The user-facing inspection is a read like any other: a forbidden page is torn down first.
    enforce_page_destination(&state, &handle).await?;
    let page = BrowserPageState {
        url: handle.current_url().await?,
        title: handle.title().await?,
        elements: Vec::new(),
        text_summary: handle
            .execute_script(PAGE_TEXT_SCRIPT, serde_json::json!([]))
            .await?
            .as_str()
            .unwrap_or("")
            .to_string(),
    };
    let screenshot = handle
        .request(
            reqwest::Method::GET,
            &format!("/session/{}/screenshot", handle.session_id),
            None,
        )
        .await?;
    let data = screenshot
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 12 * 1024 * 1024)
        .ok_or("Browser screenshot is empty or too large.")?;
    let active_tab = handle.window_handle().await?;
    let tabs = handle
        .window_handles()
        .await?
        .into_iter()
        .map(|id| BrowserTab { active: id == active_tab, id })
        .collect();
    Ok(BrowserInspection {
        running: true,
        visible,
        user_control: state.2.load(Ordering::SeqCst),
        page: Some(page),
        screenshot: Some(format!("data:image/png;base64,{data}")),
        tabs,
    })
}
#[tauri::command]
pub async fn browser_inspect(state: State<'_, BrowserState>) -> Result<BrowserInspection, String> {
    let _operation = state.1.lock().await;
    inspect_session(&state).await
}
#[tauri::command]
pub async fn browser_take_control(
    state: State<'_, BrowserState>,
) -> Result<BrowserInspection, String> {
    browser_take_control_impl(&state).await
}
async fn browser_take_control_impl(state: &BrowserState) -> Result<BrowserInspection, String> {
    // Stop new agent operations immediately; wait for the already dispatched operation.
    state.2.store(true, Ordering::SeqCst);
    state.3.fetch_add(1, Ordering::SeqCst);
    let _operation = state.1.lock().await;
    if lock_state(&state)?.is_none() {
        state.2.store(false, Ordering::SeqCst);
    }
    if lock_state(&state)?.is_some() {
        raw_handle(&state)?
            .execute_script(
                "window.__irisElementSnapshot = new Map();",
                serde_json::json!([]),
            )
            .await?;
    }
    inspect_session(&state).await
}
#[tauri::command]
pub async fn browser_return_control(
    state: State<'_, BrowserState>,
) -> Result<BrowserInspection, String> {
    browser_return_control_impl(&state).await
}
async fn browser_return_control_impl(state: &BrowserState) -> Result<BrowserInspection, String> {
    let _operation = state.1.lock().await;
    // Require an inspectable browser before giving it back. Refreshing refs invalidates old targets.
    let mut inspection = inspect_session(&state).await?;
    if inspection.running {
        raw_handle(&state)?
            .execute_script(
                "window.__irisElementSnapshot = new Map();",
                serde_json::json!([]),
            )
            .await?;
    }
    state.3.fetch_add(1, Ordering::SeqCst);
    state.2.store(false, Ordering::SeqCst);
    inspection.user_control = false;
    Ok(inspection)
}
#[tauri::command]
pub async fn browser_close_from_ui(
    state: State<'_, BrowserState>,
) -> Result<BrowserClosedResult, String> {
    browser_close_from_ui_impl(&state).await
}
async fn browser_close_from_ui_impl(state: &BrowserState) -> Result<BrowserClosedResult, String> {
    state.2.store(true, Ordering::SeqCst);
    state.3.fetch_add(1, Ordering::SeqCst);
    let _operation = state.1.lock().await;
    let previous = { lock_state(&state)?.take() };
    // Dropping also cleans up after a browser/driver crash.
    drop(previous);
    state.2.store(false, Ordering::SeqCst);
    Ok(BrowserClosedResult { closed: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_proxy::ProxyOverrides;
    use crate::web_policy::BLOCKED_DESTINATION;

    /// Starts a real chromedriver session behind the strict (production) navigation policy. The
    /// proxy is handed back so it stays alive for exactly as long as the test's session does.
    fn live_session(
        http: &reqwest::Client,
        visible: bool,
        proxy: NavigationProxy,
    ) -> (Child, SessionHandle, NavigationProxy) {
        let binary = find_browser_binary().expect("Browser required for live test");
        let port = find_free_port().unwrap();
        let mut driver = new_driver_command(port).spawn().unwrap();
        let session_id = match tauri::async_runtime::block_on(start_driver_session(
            http, port, &binary, visible, &proxy,
        )) {
            Ok(id) => id,
            Err(error) => {
                kill_driver_tree(&mut driver);
                let _ = driver.wait();
                panic!("{error}");
            }
        };
        let handle = SessionHandle {
            driver_port: port,
            session_id,
            http: http.clone(),
        };
        (driver, handle, proxy)
    }

    fn live_state(handle: SessionHandle, proxy: NavigationProxy, driver: Child) -> BrowserState {
        let state = BrowserState::default();
        *state.0.lock().unwrap() = Some(BrowserSession {
            driver,
            visible: false,
            handle,
            _proxy: proxy,
        });
        state
    }

    fn navigate_raw(handle: &SessionHandle, url: &str) -> Result<serde_json::Value, String> {
        tauri::async_runtime::block_on(handle.request(
            reqwest::Method::POST,
            &format!("/session/{}/url", handle.session_id),
            Some(serde_json::json!({ "url": url })),
        ))
    }

    fn page_text(handle: &SessionHandle) -> String {
        tauri::async_runtime::block_on(
            handle.execute_script("return document.body ? document.body.innerText : ''", serde_json::json!([])),
        )
        .ok()
        .and_then(|value| value.as_str().map(|text| text.to_string()))
        .unwrap_or_default()
    }

    fn no_connection_reached(listener: &TcpListener) {
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            listener.accept().is_err(),
            "a connection reached the loopback origin"
        );
    }

    #[test]
    #[ignore = "Requires matching Chrome/ChromeDriver and live public internet access"]
    fn live_navigation_policy_blocks_loopback_before_any_request() {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let target = listener.local_addr().unwrap();
        let (mut driver, handle, proxy) = live_session(&http, false, NavigationProxy::start().unwrap());

        // A TLS tunnel to loopback is refused by the policy. `ERR_TUNNEL_CONNECTION_FAILED` (not
        // `ERR_PROXY_CONNECTION_FAILED`) is what proves the refusal came from our live proxy.
        let tunnel = navigate_raw(&handle, &format!("https://127.0.0.1:{}/", target.port()));
        let tunnel_error = tunnel.unwrap_err();
        assert!(
            !tunnel_error.contains("ERR_PROXY_CONNECTION_FAILED"),
            "the policy proxy was not reachable: {tunnel_error}"
        );
        assert!(tunnel_error.contains("ERR_TUNNEL_CONNECTION_FAILED"), "{tunnel_error}");

        // A plain-HTTP loopback navigation is answered by the policy refusal page instead.
        let _ = navigate_raw(&handle, &format!("http://127.0.0.1:{}/secret", target.port()));
        let body = page_text(&handle);
        assert!(body.contains("network policy"), "{body}");
        assert!(!body.contains("LOCAL SECRET"), "{body}");
        no_connection_reached(&listener);

        // The metadata service is refused the same way, and is never contacted.
        let _ = navigate_raw(&handle, "http://169.254.169.254/latest/meta-data/");
        let body = page_text(&handle);
        assert!(body.contains("network policy"), "{body}");

        kill_driver_tree(&mut driver);
        let _ = driver.wait();
        drop(proxy);
    }

    #[test]
    #[ignore = "Requires matching Chrome/ChromeDriver and live public internet access"]
    fn live_navigation_policy_blocks_a_public_redirect_into_a_private_network() {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let target = listener.local_addr().unwrap();
        let (driver, handle, proxy) = live_session(&http, false, NavigationProxy::start().unwrap());
        let state = live_state(handle, proxy, driver);
        let redirector = format!(
            "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A{}%2Fsecret",
            target.port()
        );
        // The public URL passes the pre-navigation gate; the redirect target does not survive the
        // read gate, so the command fails and the page is quarantined.
        let outcome = tauri::async_runtime::block_on(navigate_impl(&state, redirector));
        let error = outcome
            .err()
            .expect("a redirect into a private network was accepted");
        assert_eq!(error, BLOCKED_DESTINATION, "{error}");
        no_connection_reached(&listener);
        let handle = raw_handle(&state).unwrap();
        let current = tauri::async_runtime::block_on(handle.current_url()).unwrap();
        assert_eq!(current, "about:blank", "the private page was not quarantined");
        tauri::async_runtime::block_on(browser_close_from_ui_impl(&state)).unwrap();
    }

    /// Serves exactly one HTTP response so a navigation has something real to render.
    fn serve_one(listener: TcpListener, body: &'static str) -> std::thread::JoinHandle<bool> {
        use std::io::{Read, Write};
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return false;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            true
        })
    }

    /// Control for every refusal test below: with the policy relaxed for this one harness, the
    /// loopback fixture really is reachable and really does render its own content. Without this,
    /// "the request never arrived" could just mean the fixture never worked.
    #[test]
    #[ignore = "Requires matching Chrome/ChromeDriver and live public internet access"]
    fn live_control_a_trusted_origin_proves_the_fixture_really_serves_content() {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = listener.local_addr().unwrap();
        let server = serve_one(listener, "<html><head><title>Served locally</title></head><body>LOCAL FIXTURE CONTENT</body></html>");
        let proxy = NavigationProxy::start_for_tests(ProxyOverrides::with_trusted_hosts(
            vec!["127.0.0.1".to_string()],
            None,
        ))
        .unwrap();
        let (driver, handle, proxy) = live_session(&http, false, proxy);
        let state = live_state(handle, proxy, driver);
        let page = tauri::async_runtime::block_on(navigate_impl(
            &state,
            format!("http://127.0.0.1:{}/fixture", target.port()),
        ))
        .unwrap();
        assert!(page.title.contains("Served locally"), "{}", page.title);
        assert!(
            page.text_summary.contains("LOCAL FIXTURE CONTENT"),
            "{}",
            page.text_summary
        );
        assert!(server.join().unwrap(), "the fixture never served a request");
        tauri::async_runtime::block_on(browser_close_from_ui_impl(&state)).unwrap();
    }

    #[test]
    #[ignore = "Requires matching Chrome/ChromeDriver and live public internet access"]
    fn live_navigation_policy_quarantines_a_scripted_navigation_into_a_private_network() {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let target = listener.local_addr().unwrap();
        let (driver, handle, proxy) = live_session(&http, false, NavigationProxy::start().unwrap());
        let state = live_state(handle, proxy, driver);
        tauri::async_runtime::block_on(navigate_impl(&state, "https://example.com/".into()))
            .unwrap();
        // Nothing in the Rust layer sees this navigation: the page itself sends the browser to the
        // private origin. Two independent boundaries must stop it — the proxy never opens the
        // socket, and the read gate tears the page down before returning anything.
        let handle = raw_handle(&state).unwrap();
        let script = format!(
            "window.location.href = 'http://127.0.0.1:{}/secret';",
            target.port()
        );
        let _ = tauri::async_runtime::block_on(
            handle.execute_script(&script, serde_json::json!([])),
        );
        std::thread::sleep(Duration::from_millis(700));
        let outcome = tauri::async_runtime::block_on(read_page(&state));
        assert_eq!(outcome.err().unwrap_or_default(), BLOCKED_DESTINATION);
        no_connection_reached(&listener);
        let handle = raw_handle(&state).unwrap();
        let current = tauri::async_runtime::block_on(handle.current_url()).unwrap();
        assert_eq!(current, "about:blank", "the private page was not quarantined");
        tauri::async_runtime::block_on(browser_close_from_ui_impl(&state)).unwrap();
    }

    #[test]
    #[ignore = "Requires matching Chrome/ChromeDriver and live public internet access"]
    fn live_navigation_policy_allows_public_https_and_denies_loopback_through_the_command() {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let target = listener.local_addr().unwrap();
        let (driver, handle, proxy) = live_session(&http, false, NavigationProxy::start().unwrap());
        let state = live_state(handle, proxy, driver);
        let page = tauri::async_runtime::block_on(navigate_impl(&state, "https://example.com/".into()))
            .unwrap();
        assert!(page.title.contains("Example Domain"), "{}", page.title);
        let page = tauri::async_runtime::block_on(navigate_impl(&state, "http://example.com/".into()))
            .unwrap();
        assert!(page.title.contains("Example Domain"), "{}", page.title);
        // Attack D: a redirect chain that stays on public hosts must still be followed. The policy
        // validates every hop and refuses none, so an all-public redirect keeps working.
        let page = tauri::async_runtime::block_on(navigate_impl(
            &state,
            "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F".into(),
        ))
        .unwrap();
        assert!(page.title.contains("Example Domain"), "{}", page.title);
        // Attack A through the real command path: denied before the driver is asked to navigate.
        let denied = tauri::async_runtime::block_on(navigate_impl(
            &state,
            format!("http://127.0.0.1:{}/admin", target.port()),
        ))
        .err()
        .unwrap();
        assert_eq!(denied, BLOCKED_DESTINATION, "{denied}");
        no_connection_reached(&listener);
        tauri::async_runtime::block_on(browser_close_from_ui_impl(&state)).unwrap();
    }

    #[test]
    fn finds_a_free_port() {
        let port = find_free_port().unwrap();
        assert!((1024..65535).contains(&port));
    }

    #[test]
    fn rejects_non_http_urls_and_forbidden_destinations() {
        let state = BrowserState::default();
        tauri::async_runtime::block_on(async {
            for url in [
                "ftp://example.com",
                "javascript:alert(1)",
                "file:///etc/passwd",
                "data:text/html,hi",
                "blob:https://example.com/1",
                "chrome://settings",
                "",
                "https://name:password@example.com/",
            ] {
                assert!(validate_url(&state, url).await.is_err(), "{url}");
            }
            // H-01: every local, private, metadata and special destination is refused here, before
            // the driver is ever asked to open it.
            for url in [
                "http://127.0.0.1:8080/",
                "http://127.1.2.3/",
                "http://localhost:3000/",
                "http://LOCALHOST/",
                "http://[::1]/",
                "http://10.0.0.1/",
                "http://172.16.9.9/",
                "http://172.31.255.254/",
                "http://192.168.1.1/",
                "http://169.254.169.254/latest/meta-data/",
                "http://100.64.0.1/",
                "http://192.0.0.1/",
                "http://198.18.0.1/",
                "http://224.0.0.1/",
                "http://0.0.0.0/",
                "http://nas.local/",
                "http://router.internal/",
            ] {
                let error = validate_url(&state, url).await.unwrap_err();
                assert_eq!(error, BLOCKED_DESTINATION, "{url}");
            }
            assert!(validate_url(&state, "https://example.com/page").await.is_ok());
            assert!(validate_url(&state, "http://1.1.1.1/").await.is_ok());
        });
    }

    #[test]
    fn only_the_internal_blank_page_escapes_the_web_scheme_rule() {
        assert!(is_internal_blank_page("about:blank"));
        assert!(is_internal_blank_page(" data:,"));
        for url in ["about:config", "data:text/html,<h1>x</h1>", "file:///etc/passwd"] {
            assert!(!is_internal_blank_page(url), "{url}");
        }
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
    #[test]
    fn user_control_blocks_tools_and_invalidates_queued_actions() {
        tauri::async_runtime::block_on(async {
            let state = BrowserState::default();
            let epoch = state.3.load(Ordering::SeqCst);
            state.2.store(true, Ordering::SeqCst);
            state.3.fetch_add(1, Ordering::SeqCst);
            assert!(automated_guard(&state).await.is_err());
            // Returning control must not revive a command queued before takeover.
            state.2.store(false, Ordering::SeqCst);
            assert!(guard_at_epoch(&state, epoch).await.is_err());
            assert!(automated_guard(&state).await.is_ok());
        });
    }

    #[test]
    #[ignore = "Requires matching Chrome/ChromeDriver and a graphical display"]
    fn live_visible_browser_takeover_and_stale_refs() {
        use base64::Engine;
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let server = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer);
                let body = "<!doctype html><title>IRIS browser verification</title><h1>Real browser test</h1><input id='entry'><button id='action' onclick=\"document.querySelector('h1').textContent='Clicked by WebDriver'\">Apply local test</button>";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        tauri::async_runtime::block_on(async {
            let binary = find_browser_binary().expect("Browser required for live test");
            let port = find_free_port().unwrap();
            let mut driver = new_driver_command(port).spawn().unwrap();
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap();
            // This harness deliberately drives a loopback origin. The trusted-host override exists
            // only in test builds; it is what lets the real WebDriver path be exercised while the
            // policy itself stays strict everywhere else.
            let proxy = NavigationProxy::start_for_tests(ProxyOverrides::with_trusted_hosts(
                vec!["127.0.0.1".to_string()],
                None,
            ))
            .unwrap();
            let session_id =
                match start_driver_session(&http, port, &binary, true, &proxy).await {
                    Ok(id) => id,
                    Err(error) => {
                        kill_driver_tree(&mut driver);
                        let _ = driver.wait();
                        panic!("{error}");
                    }
                };
            let handle = SessionHandle {
                driver_port: port,
                session_id,
                http,
            };
            let state = BrowserState::default();
            *state.0.lock().unwrap() = Some(BrowserSession {
                driver,
                visible: true,
                handle: handle.clone(),
                _proxy: proxy,
            });
            handle
                .request(
                    reqwest::Method::POST,
                    &format!("/session/{}/url", handle.session_id),
                    Some(serde_json::json!({"url":format!("http://{address}/")})),
                )
                .await
                .unwrap();
            let first = handle.snapshot().await.unwrap();
            let old_ref = first
                .elements
                .iter()
                .find(|element| element.id.as_deref() == Some("action"))
                .unwrap()
                .reference;
            let next = handle.snapshot().await.unwrap();
            assert!(handle
                .locate_element(Some(old_ref as f64), None, None)
                .await
                .is_err());
            let reference = next
                .elements
                .iter()
                .find(|element| element.id.as_deref() == Some("action"))
                .unwrap()
                .reference;
            let element = handle
                .locate_element(Some(reference as f64), None, None)
                .await
                .unwrap();
            handle
                .request(
                    reqwest::Method::POST,
                    &format!("/session/{}/element/{element}/click", handle.session_id),
                    Some(serde_json::json!({})),
                )
                .await
                .unwrap();
            assert!(handle
                .snapshot()
                .await
                .unwrap()
                .text_summary
                .contains("Clicked by WebDriver"));
            let owned = browser_take_control_impl(&state).await.unwrap();
            assert!(owned.running && owned.visible && owned.user_control);
            assert!(automated_guard(&state).await.is_err());
            if let Ok(directory) = std::env::var("IRIS_BROWSER_TEST_ARTIFACT_DIR") {
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(
                    std::path::Path::new(&directory).join("inspection.json"),
                    serde_json::to_vec(&owned).unwrap(),
                )
                .unwrap();
            }
            let screenshot = owned.screenshot.unwrap();
            let png = base64::engine::general_purpose::STANDARD
                .decode(screenshot.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            assert!(png.starts_with(&[137, 80, 78, 71]));
            // A real WebDriver input while user ownership is held represents manual browser interaction.
            let input = handle
                .locate_element(None, Some("#entry"), None)
                .await
                .unwrap();
            handle
                .request(
                    reqwest::Method::POST,
                    &format!("/session/{}/element/{input}/value", handle.session_id),
                    Some(serde_json::json!({"text":"Manual handover test"})),
                )
                .await
                .unwrap();
            let returned = browser_return_control_impl(&state).await.unwrap();
            assert!(!returned.user_control);
            assert!(automated_guard(&state).await.is_ok());
            assert!(handle
                .locate_element(Some(reference as f64), None, None)
                .await
                .is_err());
            assert_eq!(
                handle
                    .execute_script(
                        "return document.querySelector('#entry').value",
                        serde_json::json!([])
                    )
                    .await
                    .unwrap(),
                "Manual handover test"
            );
            browser_close_from_ui_impl(&state).await.unwrap();
            assert!(!inspect_session(&state).await.unwrap().running);
        });
        stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(address);
        server.join().unwrap();
    }
}
