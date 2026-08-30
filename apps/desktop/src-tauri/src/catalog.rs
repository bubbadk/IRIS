use std::time::Duration;

/// These directories and source documents do not provide the CORS access the webview needs. The
/// request is made from the native side instead, and these are the only hosts and path prefixes it
/// is ever allowed to reach.
const ALLOWED_DIRECTORIES: &[(&str, &str)] = &[
    ("skillsplayground.com", "/api/"),
    ("registry.modelcontextprotocol.io", "/v0.1/"),
    // A skill's real instructions live in its source repository, which the directory only links to.
    ("raw.githubusercontent.com", "/"),
];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

fn validate(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "The directory address is not a valid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("A directory must be reached over HTTPS.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Directory addresses cannot contain credentials.".to_string());
    }
    let host = parsed.host_str().unwrap_or_default();
    let prefix = ALLOWED_DIRECTORIES
        .iter()
        .find(|(allowed, _)| *allowed == host)
        .map(|(_, prefix)| *prefix)
        .ok_or_else(|| format!("IRIS does not reach {host} for directory requests."))?;
    if !parsed.path().starts_with(prefix) {
        return Err(format!(
            "Directory requests to {host} are limited to {prefix} paths."
        ));
    }
    if host == "raw.githubusercontent.com"
        && (!parsed.path().to_ascii_lowercase().ends_with(".md") || parsed.query().is_some())
    {
        return Err("Skill source requests are limited to public Markdown documents.".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn fetch_directory(url: String) -> Result<String, String> {
    let target = validate(&url)?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("IRIS could not start the catalog request: {error}"))?;
    let response = client
        .get(target)
        .header("accept", "text/plain, application/json")
        .send()
        .await
        .map_err(|error| format!("The directory resource could not be reached: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "The directory resource answered {} {}.",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Error")
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("The directory response could not be read: {error}"))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err("The directory response exceeded the size IRIS will read.".to_string());
    }
    String::from_utf8(body.to_vec())
        .map_err(|_| "The directory returned a non-UTF-8 response.".to_string())
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_the_documented_catalog_endpoints() {
        assert!(validate("https://skillsplayground.com/api/v1/skills?limit=12").is_ok());
        assert!(validate("https://skillsplayground.com/api/skills").is_ok());
        assert!(validate("https://registry.modelcontextprotocol.io/v0.1/servers?limit=20").is_ok());
        assert!(
            validate("https://raw.githubusercontent.com/anthropics/skills/main/x/SKILL.md").is_ok()
        );
    }

    #[test]
    fn rejects_any_other_host_scheme_or_path() {
        assert!(validate("https://example.com/api/skills").is_err());
        assert!(validate("http://skillsplayground.com/api/skills").is_err());
        assert!(validate("https://evil.skillsplayground.com.attacker.net/api/x").is_err());
        assert!(validate("https://skillsplayground.com/admin").is_err());
        assert!(validate("not a url").is_err());
    }

    #[test]
    fn keeps_each_allowed_host_to_its_own_path_prefix() {
        // The registry prefix must not open up the skill host, or the other way round.
        assert!(validate("https://skillsplayground.com/v0.1/servers").is_err());
        assert!(validate("https://registry.modelcontextprotocol.io/api/skills").is_err());
        // The raw host is deliberately open at the path level, but still only that one host.
        assert!(validate("https://github.com/anthropics/skills/blob/main/x/SKILL.md").is_err());
        assert!(validate("https://gist.githubusercontent.com/x/y/raw/z").is_err());
    }

    #[test]
    fn rejects_credentials_smuggled_through_the_authority() {
        assert!(validate("https://user:pass@example.com/api/skills").is_err());
        assert!(validate("https://user:pass@raw.githubusercontent.com/x/y/main/SKILL.md").is_err());
    }

    #[test]
    fn limits_the_raw_source_host_to_markdown_documents_without_queries() {
        assert!(validate("https://raw.githubusercontent.com/x/y/main/SKILL.md").is_ok());
        assert!(validate("https://raw.githubusercontent.com/x/y/main/secrets.json").is_err());
        assert!(validate("https://raw.githubusercontent.com/x/y/main/SKILL.md?token=x").is_err());
    }
}
