//! Durable pre-edit text snapshots. Never infer an external action's success from a timer.
use crate::workspace::{
    mounted_root, patched_content, resolve_write_target, write_file_at,
    NativeWorkspaceMutationResult, NativeWorkspacePatchResult, WorkspaceState,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

pub static FILE_EDIT_LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: usize = 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestorePoint {
    version: u8,
    id: String,
    root_path: PathBuf,
    path: String,
    created_at_ms: u64,
    before: Option<String>,
    after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointSummary {
    id: String,
    path: String,
    created_at_ms: u64,
    state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    summary: RestorePointSummary,
    before: Option<String>,
    after: String,
}

fn history_dir(base: &Path, root: &Path) -> PathBuf {
    // Stable directory key, with the full canonical root checked again on every read.
    let hash = root
        .to_string_lossy()
        .bytes()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    base.join(format!("{hash:016x}"))
}

fn app_history(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("workspace-restore-v1"))
        .map_err(|error| format!("Restore-point storage is unavailable: {error}"))
}

fn snapshot(root: &Path, path: &str) -> Result<Option<String>, String> {
    let (_, target, _) = resolve_write_target(root, path)?;
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Cannot inspect the file for a restore point: {error}"
        )),
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
                return Err(
                    "Reversible workspace edits require a regular text file no larger than 1 MiB."
                        .into(),
                );
            }
            let mut bytes = Vec::new();
            fs::File::open(target)
                .and_then(|file| file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes))
                .map_err(|error| format!("Cannot save the original file: {error}"))?;
            if bytes.len() > MAX_BYTES {
                return Err("The original file exceeds the 1 MiB restore limit.".into());
            }
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "Reversible workspace edits require UTF-8 text.".into())
        }
    }
}

fn save_point(
    base: &Path,
    root: &Path,
    path: &str,
    before: Option<String>,
    after: &str,
) -> Result<String, String> {
    let dir = history_dir(base, root);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create restore-point storage: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let id = format!(
        "{}-{}-{}",
        now.as_nanos(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let point = RestorePoint {
        version: 1,
        id: id.clone(),
        root_path: root.into(),
        path: path.into(),
        created_at_ms: now.as_millis() as u64,
        before,
        after: after.into(),
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let target = dir.join(format!("{id}.json"));
    let temporary = dir.join(format!("{id}.pending"));
    let mut file = options
        .open(&temporary)
        .map_err(|e| format!("Cannot save restore point; file was not edited: {e}"))?;
    let data = serde_json::to_vec(&point).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(&data).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Cannot persist restore point; file was not edited: {error}"
        ));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Cannot commit restore point; file was not edited: {error}"
        ));
    }
    #[cfg(unix)]
    fs::File::open(&dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| format!("Cannot persist restore-point directory; file was not edited: {e}"))?;
    Ok(id)
}

pub fn write_reversible_at(
    root: &Path,
    base: &Path,
    path: &str,
    content: &str,
    overwrite: bool,
) -> Result<NativeWorkspaceMutationResult, String> {
    write_reversible_checked(root, base, path, content, overwrite, None)
}

fn write_reversible_checked(
    root: &Path,
    base: &Path,
    path: &str,
    content: &str,
    overwrite: bool,
    expected: Option<&str>,
) -> Result<NativeWorkspaceMutationResult, String> {
    if content.len() > MAX_BYTES {
        return Err("Workspace file content exceeds the 1 MiB write limit.".into());
    }
    let before = snapshot(root, path)?;
    if expected.is_some() && before.as_deref() != expected {
        return Err(
            "The file changed before the patch could be saved. Read it again before editing."
                .into(),
        );
    }
    if before.is_some() && !overwrite {
        return Err("Workspace file already exists. Set overwrite to true only when replacement is intended.".into());
    }
    if before.as_deref() == Some(content) {
        return write_file_at(root, path, content, overwrite);
    }
    let id = save_point(base, root, path, before.clone(), content)?;
    if snapshot(root, path)? != before {
        return Err(
            "The file changed while saving its restore point. Read it again before editing.".into(),
        );
    }
    let mut result = write_file_at(root, path, content, overwrite)?;
    result.restore_point_id = Some(id);
    Ok(result)
}

pub fn patch_reversible_at(
    root: &Path,
    base: &Path,
    path: &str,
    expected: &str,
    updated: &str,
) -> Result<NativeWorkspacePatchResult, String> {
    let before = snapshot(root, path)?.ok_or("Workspace patch target is unavailable.")?;
    let after = patched_content(&before, expected, updated)?;
    let result = write_reversible_checked(root, base, path, &after, true, Some(&before))?;
    Ok(NativeWorkspacePatchResult {
        relative_path: result.relative_path,
        kind: "file",
        created: false,
        bytes_written: if before == after {
            Some(0)
        } else {
            result.bytes_written
        },
        changed: before != after,
        restore_point_id: result.restore_point_id,
    })
}

fn load_point(base: &Path, root: &Path, id: &str) -> Result<RestorePoint, String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Invalid restore-point identity.".into());
    }
    let target = history_dir(base, root).join(format!("{id}.json"));
    let metadata =
        fs::symlink_metadata(&target).map_err(|e| format!("Restore point is unavailable: {e}"))?;
    if !metadata.is_file() || metadata.len() > (MAX_BYTES * 12 + 4096) as u64 {
        return Err("Restore point has invalid contents.".into());
    }
    let point: RestorePoint = serde_json::from_slice(&fs::read(target).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Restore point could not be read: {e}"))?;
    if point.version != 1
        || point.id != id
        || point.root_path != root
        || point.after.len() > MAX_BYTES
        || point
            .before
            .as_ref()
            .is_some_and(|before| before.len() > MAX_BYTES)
    {
        return Err("Restore point does not match this workspace.".into());
    }
    Ok(point)
}

fn summarize(root: &Path, point: &RestorePoint) -> RestorePointSummary {
    let state = match snapshot(root, &point.path) {
        Ok(current) if current.as_deref() == Some(&point.after) => "ready",
        Ok(current) if current == point.before => "original",
        Ok(_) => "conflict",
        Err(_) => "unavailable",
    };
    RestorePointSummary {
        id: point.id.clone(),
        path: point.path.clone(),
        created_at_ms: point.created_at_ms,
        state,
    }
}

fn list_at(base: &Path, root: &Path) -> Result<Vec<RestorePointSummary>, String> {
    let entries = match fs::read_dir(history_dir(base, root)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Restore-point history is unavailable: {e}")),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|value| value == "json") {
            ids.push(
                path.file_stem()
                    .ok_or("Invalid restore-point filename.")?
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    ids.sort();
    ids.into_iter()
        .rev()
        .take(50)
        .map(|id| load_point(base, root, &id).map(|point| summarize(root, &point)))
        .collect()
}

fn restore_at(base: &Path, root: &Path, id: &str) -> Result<String, String> {
    let point = load_point(base, root, id)?;
    if snapshot(root, &point.path)?.as_deref() != Some(&point.after) {
        return Err(
            "The file changed since this edit. Restore was refused to preserve newer work.".into(),
        );
    }
    if let Some(before) = point.before {
        write_file_at(root, &point.path, &before, true)?;
    } else {
        let (_, target, _) = resolve_write_target(root, &point.path)?;
        fs::remove_file(target).map_err(|e| format!("Could not undo file creation: {e}"))?;
    }
    Ok(point.path)
}

#[tauri::command]
pub fn list_workspace_restore_points(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<RestorePointSummary>, String> {
    let _guard = FILE_EDIT_LOCK
        .lock()
        .map_err(|_| "Workspace edit lock is unavailable.")?;
    list_at(&app_history(&app)?, &mounted_root(&state)?)
}

#[tauri::command]
pub fn preview_workspace_restore_point(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<RestorePreview, String> {
    let _guard = FILE_EDIT_LOCK
        .lock()
        .map_err(|_| "Workspace edit lock is unavailable.")?;
    let root = mounted_root(&state)?;
    let point = load_point(&app_history(&app)?, &root, &id)?;
    Ok(RestorePreview {
        summary: summarize(&root, &point),
        before: point.before,
        after: point.after,
    })
}

#[tauri::command]
pub fn restore_workspace_file(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<String, String> {
    let _guard = FILE_EDIT_LOCK
        .lock()
        .map_err(|_| "Workspace edit lock is unavailable.")?;
    restore_at(&app_history(&app)?, &mounted_root(&state)?, &id)
}

pub fn storage_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_history(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        history: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "iris-restore-test-{}-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let root = base.join("workspace");
            fs::create_dir_all(&root).unwrap();
            Self {
                history: base.join("history"),
                base,
                root,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    #[test]
    fn restores_existing_and_new_files_from_durable_history() {
        let f = Fixture::new();
        fs::write(f.root.join("a.txt"), "original\r\n").unwrap();
        let edit = write_reversible_at(&f.root, &f.history, "a.txt", "updated", true).unwrap();
        assert_eq!(list_at(&f.history, &f.root).unwrap()[0].state, "ready");
        restore_at(&f.history, &f.root, edit.restore_point_id.as_ref().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "original\r\n"
        );
        assert_eq!(list_at(&f.history, &f.root).unwrap()[0].state, "original");
        let created =
            write_reversible_at(&f.root, &f.history, "new.txt", "created", false).unwrap();
        restore_at(
            &f.history,
            &f.root,
            created.restore_point_id.as_ref().unwrap(),
        )
        .unwrap();
        assert!(!f.root.join("new.txt").exists());
    }
    #[test]
    fn refuses_stale_and_wrong_workspace_restores() {
        let f = Fixture::new();
        let created = write_reversible_at(&f.root, &f.history, "a.txt", "created", false).unwrap();
        fs::write(f.root.join("a.txt"), "newer user work").unwrap();
        assert!(restore_at(
            &f.history,
            &f.root,
            created.restore_point_id.as_ref().unwrap()
        )
        .unwrap_err()
        .contains("preserve newer work"));
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "newer user work"
        );
        assert!(restore_at(
            &f.history,
            &f.base,
            created.restore_point_id.as_ref().unwrap()
        )
        .is_err());
        assert!(restore_at(&f.history, &f.root, "../escape").is_err());
    }
    #[test]
    fn journal_failure_prevents_the_file_edit() {
        let f = Fixture::new();
        fs::write(&f.history, "not a directory").unwrap();
        assert!(write_reversible_at(&f.root, &f.history, "a.txt", "updated", false).is_err());
        assert!(!f.root.join("a.txt").exists());
    }
    #[test]
    fn restores_the_whole_original_file_after_a_snippet_patch() {
        let f = Fixture::new();
        fs::write(f.root.join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let edit = patch_reversible_at(&f.root, &f.history, "a.txt", "beta", "changed").unwrap();
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "alpha\nchanged\ngamma\n"
        );
        restore_at(&f.history, &f.root, edit.restore_point_id.as_ref().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "alpha\nbeta\ngamma\n"
        );
    }
    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_substituted_before_restore() {
        let f = Fixture::new();
        let edit = write_reversible_at(&f.root, &f.history, "a.txt", "created", false).unwrap();
        fs::remove_file(f.root.join("a.txt")).unwrap();
        fs::write(f.base.join("outside"), "outside").unwrap();
        std::os::unix::fs::symlink(f.base.join("outside"), f.root.join("a.txt")).unwrap();
        assert!(restore_at(&f.history, &f.root, edit.restore_point_id.as_ref().unwrap()).is_err());
        assert_eq!(
            fs::read_to_string(f.base.join("outside")).unwrap(),
            "outside"
        );
    }
}
