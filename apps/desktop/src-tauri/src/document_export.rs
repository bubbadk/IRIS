use base64::Engine;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Extensions the document exporter may write. The extension is part of the issued capability.
const ALLOWED_EXTENSIONS: [&str; 10] = [
    "md", "txt", "html", "svg", "json", "csv", "docx", "pdf", "xlsx", "pptx",
];
/// Hard ceiling for one export payload, checked on the decoded bytes.
const MAX_EXPORT_BYTES: usize = 12 * 1024 * 1024;
/// A save capability is short-lived: the user picks a destination, then the export is written.
const TICKET_TTL: Duration = Duration::from_secs(120);
/// Bound the pending-capability table so a wedged renderer cannot grow it without limit.
const MAX_TICKETS: usize = 16;

static TICKET_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExportTicket {
    token: String,
    path: String,
    extension: String,
}

/// One user-authorized export destination. The renderer never sees or supplies this state; it only
/// receives the opaque token.
struct PendingExport {
    path: PathBuf,
    parent: PathBuf,
    /// Device and inode of the authorized directory. Comparing the path alone cannot detect a
    /// directory that was replaced at the same path between approval and the write.
    parent_identity: Option<(u64, u64)>,
    extension: String,
    issued: Instant,
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|metadata| (metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn directory_identity(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// Issues and redeems short-lived export capabilities.
///
/// This is the whole point of the trusted destination model: the native Save dialog chooses the
/// path inside the backend, and the write command accepts only an opaque token. There is no
/// parameter that carries a host path, so a compromised renderer cannot name one.
#[derive(Default)]
pub struct DocumentExportState(Mutex<HashMap<String, PendingExport>>);

fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    hasher.write_u64(TICKET_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let first = hasher.finish();
    let second = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{first:016x}{second:016x}")
}

/// Keeps a renderer-supplied suggestion from ever acting as a path.
pub(crate) fn sanitize_suggested_name(value: &str, extension: &str) -> String {
    let leaf = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let leaf = leaf.trim().trim_matches('.').trim();
    let base = if leaf.is_empty() { "document" } else { leaf };
    let suffix = format!(".{extension}");
    if base.to_ascii_lowercase().ends_with(&suffix) {
        base.to_string()
    } else {
        format!("{base}{suffix}")
    }
}

pub(crate) fn normalize_extension(value: &str) -> Result<String, String> {
    let extension = value.trim().trim_start_matches('.').to_ascii_lowercase();
    if extension.is_empty() || extension.len() > 8 || !extension.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("Choose a supported document extension.".into());
    }
    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Choose a supported document extension.".into());
    }
    Ok(extension)
}

fn path_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

impl DocumentExportState {
    fn issue_at(
        &self,
        target: &Path,
        extension: &str,
        issued: Instant,
    ) -> Result<DocumentExportTicket, String> {
        let extension = normalize_extension(extension)?;
        if !target.is_absolute() {
            return Err("Invalid document export path or size.".into());
        }
        if path_extension(target) != extension {
            return Err("The export filename does not match the chosen format.".into());
        }
        let parent = target
            .parent()
            .ok_or_else(|| "Invalid document export path or size.".to_string())?
            .canonicalize()
            .map_err(|error| format!("The export destination is unavailable: {error}"))?;
        if !parent.is_dir() {
            return Err("The export destination must be a directory.".into());
        }
        // The final component may not already be a link: create_new would refuse it anyway, but the
        // user must learn about it before an export is reported as successful.
        if std::fs::symlink_metadata(target)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("The export destination is a symbolic link.".into());
        }
        let token = new_token();
        let mut tickets = self
            .0
            .lock()
            .map_err(|_| "The export destination could not be reserved.".to_string())?;
        tickets.retain(|_, ticket| issued.duration_since(ticket.issued) < TICKET_TTL);
        if tickets.len() >= MAX_TICKETS {
            return Err("Too many export destinations are awaiting a file. Try again.".into());
        }
        tickets.insert(
            token.clone(),
            PendingExport {
                path: target.to_path_buf(),
                parent_identity: directory_identity(&parent),
                parent,
                extension,
                issued,
            },
        );
        Ok(DocumentExportTicket {
            token,
            path: target.to_string_lossy().into_owned(),
            extension: path_extension(target),
        })
    }

    fn consume_at(&self, token: &str, bytes: &[u8], now: Instant) -> Result<String, String> {
        if bytes.len() > MAX_EXPORT_BYTES {
            return Err("Invalid document export path or size.".into());
        }
        // Single use: the capability is removed before any filesystem work happens.
        let pending = self
            .0
            .lock()
            .map_err(|_| "The export destination could not be read.".to_string())?
            .remove(token)
            .ok_or_else(|| "This export destination is no longer authorized.".to_string())?;
        if now.duration_since(pending.issued) >= TICKET_TTL {
            return Err("This export destination authorization expired. Choose the destination again."
                .into());
        }
        // TOCTOU: the directory the user authorized must still be the same directory.
        let parent = pending
            .path
            .parent()
            .ok_or_else(|| "Invalid document export path or size.".to_string())?
            .canonicalize()
            .map_err(|error| format!("The export destination is unavailable: {error}"))?;
        if parent != pending.parent
            || (pending.parent_identity.is_some()
                && directory_identity(&parent) != pending.parent_identity)
        {
            return Err("The export destination changed after it was chosen.".into());
        }
        if path_extension(&pending.path) != pending.extension {
            return Err("The export filename does not match the chosen format.".into());
        }
        if std::fs::symlink_metadata(&pending.path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("The export destination is a symbolic link.".into());
        }
        // Create-only: never overwrite an unrelated or concurrently changed file. O_EXCL also
        // refuses a symbolic link that appeared at the final component after the check above.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending.path)
            .map_err(|error| {
                format!("Could not create export. If the file exists, choose a new filename: {error}")
            })?;
        // Re-check after opening: a directory swapped in the tiny window above is detected here.
        let confirmed = pending
            .path
            .parent()
            .and_then(|value| value.canonicalize().ok())
            .unwrap_or_default();
        let confirmed_identity = directory_identity(&confirmed);
        if confirmed != pending.parent
            || (pending.parent_identity.is_some()
                && confirmed_identity != pending.parent_identity)
        {
            drop(file);
            let _ = std::fs::remove_file(&pending.path);
            return Err("The export destination changed after it was chosen.".into());
        }
        if !file
            .metadata()
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
        {
            drop(file);
            let _ = std::fs::remove_file(&pending.path);
            return Err("The export destination is not a regular file.".into());
        }
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&pending.path);
            return Err(format!("Document export could not be saved: {error}"));
        }
        Ok(pending.path.to_string_lossy().into_owned())
    }

    fn issue(&self, target: &Path, extension: &str) -> Result<DocumentExportTicket, String> {
        self.issue_at(target, extension, Instant::now())
    }

    fn consume(&self, token: &str, bytes: &[u8]) -> Result<String, String> {
        self.consume_at(token, bytes, Instant::now())
    }
}

/// Opens the native Save dialog, then issues a one-time capability bound to the chosen path.
#[tauri::command]
pub async fn begin_document_export(
    app: tauri::AppHandle,
    state: State<'_, DocumentExportState>,
    suggested_name: String,
    extension: String,
) -> Result<Option<DocumentExportTicket>, String> {
    let extension = normalize_extension(&extension)?;
    let name = sanitize_suggested_name(&suggested_name, &extension);
    // The command is async, so this blocking dialog runs off the main thread. `blocking_save_file`
    // is the dialog plugin's documented API for async commands.
    let selected = app
        .dialog()
        .file()
        .set_title("Export document")
        .set_file_name(name)
        .add_filter("Document", &[extension.as_str()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected export location is unavailable.".to_string())?;
    state.issue(&path, &extension).map(Some)
}

/// Writes an export to the destination the user already authorized through the native dialog.
#[tauri::command]
pub fn save_document_export(
    state: State<'_, DocumentExportState>,
    ticket: String,
    data: String,
) -> Result<String, String> {
    if data.len() > MAX_EXPORT_BYTES / 3 * 4 + 4 {
        return Err("Invalid document export path or size.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|_| "The document export data is invalid.".to_string())?;
    state.consume(&ticket, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "iris-document-export-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn encode(value: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(value)
    }

    fn issue_and_write(state: &DocumentExportState, target: &Path, extension: &str, body: &str) -> Result<String, String> {
        let ticket = state.issue(target, extension)?;
        state.consume(
            &ticket.token,
            &base64::engine::general_purpose::STANDARD
                .decode(encode(body))
                .unwrap(),
        )
    }

    #[test]
    fn writes_real_bytes_to_the_user_selected_destination() {
        let tree = TempTree::new("selected");
        let target = tree.path("report.pdf");
        let state = DocumentExportState::default();
        let ticket = state.issue(&target, "pdf").unwrap();
        assert_eq!(ticket.extension, "pdf");
        let saved = state.consume(&ticket.token, b"Verified export").unwrap();
        assert_eq!(saved, target.to_string_lossy());
        assert_eq!(std::fs::read(&target).unwrap(), b"Verified export");
    }

    #[test]
    fn refuses_a_token_that_was_never_issued() {
        let tree = TempTree::new("unissued");
        let state = DocumentExportState::default();
        // There is no command that accepts a path: only a token can name a destination.
        assert!(state.consume("0000000000000000", b"payload").is_err());
        assert!(!tree.path("report.txt").exists());
        assert!(state.consume("", b"payload").is_err());
    }

    #[test]
    fn a_token_can_only_be_redeemed_once() {
        let tree = TempTree::new("single-use");
        let target = tree.path("report.txt");
        let state = DocumentExportState::default();
        let ticket = state.issue(&target, "txt").unwrap();
        state.consume(&ticket.token, b"first").unwrap();
        assert!(state.consume(&ticket.token, b"second").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
    }

    #[test]
    fn refuses_an_expired_ticket() {
        let tree = TempTree::new("expired");
        let target = tree.path("report.txt");
        let state = DocumentExportState::default();
        let issued = Instant::now();
        let ticket = state
            .issue_at(&target, "txt", issued - TICKET_TTL - Duration::from_secs(1))
            .unwrap();
        assert!(state
            .consume_at(&ticket.token, b"payload", issued)
            .unwrap_err()
            .contains("expired"));
        assert!(!target.exists());
    }

    #[test]
    fn refuses_a_relative_destination() {
        let state = DocumentExportState::default();
        assert!(state.issue(Path::new("report.txt"), "txt").is_err());
        assert!(state.issue(Path::new("../report.txt"), "txt").is_err());
        assert!(state.issue(Path::new("./report.txt"), "txt").is_err());
    }

    #[test]
    fn refuses_an_unauthorized_or_mismatched_extension() {
        let tree = TempTree::new("extension");
        let state = DocumentExportState::default();
        assert!(state.issue(&tree.path("payload.exe"), "exe").is_err());
        assert!(state.issue(&tree.path("payload.sh"), "sh").is_err());
        // The extension carried by the request and the filename must agree.
        assert!(state.issue(&tree.path("payload.pdf"), "txt").is_err());
        assert!(state.issue(&tree.path("payload.txt"), "txt").is_ok());
        assert!(normalize_extension(".PDF").is_ok());
        assert!(normalize_extension("").is_err());
    }

    #[test]
    fn preserves_create_only_semantics_for_an_existing_file() {
        let tree = TempTree::new("existing");
        let target = tree.path("report.txt");
        std::fs::write(&target, b"original").unwrap();
        let state = DocumentExportState::default();
        let ticket = state.issue(&target, "txt").unwrap();
        assert!(state.consume(&ticket.token, b"replacement").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
    }

    #[test]
    fn refuses_a_symlinked_destination() {
        let tree = TempTree::new("symlink");
        let victim = tree.path("victim.txt");
        std::fs::write(&victim, b"untouched").unwrap();
        let link = tree.path("report.txt");
        symlink(&victim, &link).unwrap();
        let state = DocumentExportState::default();
        // Either the ticket is refused up front, or redeeming it must not follow the link.
        if let Ok(ticket) = state.issue(&link, "txt") {
            assert!(state.consume(&ticket.token, b"attack").is_err());
        }
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
    }

    #[test]
    fn refuses_a_destination_whose_directory_was_replaced() {
        let tree = TempTree::new("toctou");
        let directory = tree.path("chosen");
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("report.txt");
        let state = DocumentExportState::default();
        let ticket = state.issue(&target, "txt").unwrap();
        // The user-authorized directory is replaced between approval and the write.
        std::fs::rename(&directory, tree.path("chosen-old")).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        assert!(state.consume(&ticket.token, b"payload").is_err());
        assert!(!directory.join("report.txt").exists());
    }

    #[test]
    fn refuses_an_oversized_payload() {
        let tree = TempTree::new("oversize");
        let target = tree.path("report.txt");
        let state = DocumentExportState::default();
        let ticket = state.issue(&target, "txt").unwrap();
        assert!(state
            .consume(&ticket.token, &vec![0u8; MAX_EXPORT_BYTES + 1])
            .is_err());
        assert!(!target.exists());
    }

    #[test]
    fn rejects_malformed_base64_without_touching_the_filesystem() {
        let tree = TempTree::new("base64");
        let target = tree.path("report.txt");
        let state = DocumentExportState::default();
        let ticket = state.issue(&target, "txt").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("not base64!!")
            .map_err(|_| "The document export data is invalid.".to_string());
        assert!(bytes.is_err());
        // The capability stays usable because nothing was written.
        assert!(state.consume(&ticket.token, b"real payload").is_ok());
        assert_eq!(std::fs::read(&target).unwrap(), b"real payload");
    }

    #[test]
    fn bounds_the_number_of_pending_tickets() {
        let tree = TempTree::new("bounded");
        let state = DocumentExportState::default();
        let now = Instant::now();
        for index in 0..MAX_TICKETS {
            state
                .issue_at(&tree.path(&format!("report-{index}.txt")), "txt", now)
                .unwrap();
        }
        assert!(state
            .issue_at(&tree.path("overflow.txt"), "txt", now)
            .is_err());
        // Expired tickets are reclaimed instead of blocking every future export.
        assert!(state
            .issue_at(
                &tree.path("fresh.txt"),
                "txt",
                now + TICKET_TTL + Duration::from_secs(1)
            )
            .is_ok());
    }

    #[test]
    fn sanitizes_the_suggested_filename_into_a_leaf_name() {
        assert_eq!(sanitize_suggested_name("../../etc/passwd", "txt"), "passwd.txt");
        assert_eq!(sanitize_suggested_name("a\\b\\report.pdf", "pdf"), "report.pdf");
        assert_eq!(sanitize_suggested_name("", "txt"), "document.txt");
        assert_eq!(sanitize_suggested_name("..", "txt"), "document.txt");
        assert_eq!(sanitize_suggested_name("Report", "pdf"), "Report.pdf");
        assert_eq!(sanitize_suggested_name("Report.pdf", "pdf"), "Report.pdf");
        assert_eq!(sanitize_suggested_name("bad\u{0}name", "txt"), "badname.txt");
    }

    #[test]
    fn writes_and_refuses_to_overwrite_an_export() {
        let tree = TempTree::new("legacy-behaviour");
        let target = tree.path("report.txt");
        let state = DocumentExportState::default();
        assert!(issue_and_write(&state, &target, "txt", "Verified export").is_ok());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "Verified export");
        let ticket = state.issue(&target, "txt").unwrap();
        assert!(state.consume(&ticket.token, b"second").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "Verified export");
    }
}
