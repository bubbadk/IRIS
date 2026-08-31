use serde::Serialize;
use std::{
    cmp::Ordering,
    fs::{self, OpenOptions},
    io::{Read, Take, Write},
    path::{Component, Path, PathBuf},
    sync::RwLock,
    time::UNIX_EPOCH,
};
use tauri::State;

const LIST_LIMIT: usize = 500;
const SEARCH_ENTRY_LIMIT: usize = 20_000;
const SEARCH_FILE_BYTES: u64 = 256 * 1024;
const DEFAULT_READ_BYTES: usize = 200 * 1024;
const MAX_READ_BYTES: usize = 1024 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct WorkspaceState(RwLock<Option<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMount {
    name: String,
    root_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceEntry {
    name: String,
    relative_path: String,
    kind: &'static str,
    size: Option<u64>,
    modified_at_ms: Option<u128>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceListing {
    relative_path: String,
    entries: Vec<NativeWorkspaceEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceTextFile {
    relative_path: String,
    content: String,
    bytes_read: usize,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceSearchMatch {
    relative_path: String,
    r#match: &'static str,
    line: Option<usize>,
    preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceSearchResult {
    query: String,
    matches: Vec<NativeWorkspaceSearchMatch>,
    scanned_entries: usize,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMutationResult {
    relative_path: String,
    kind: &'static str,
    created: bool,
    bytes_written: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMoveResult {
    source_path: String,
    target_path: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDeleteResult {
    relative_path: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspacePatchResult {
    relative_path: String,
    kind: &'static str,
    created: bool,
    bytes_written: Option<usize>,
    changed: bool,
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn relative_text(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(path_text)
        .map_err(|_| "Workspace path escaped the mounted root.".to_string())
}

fn validate_relative(relative_path: &str, allow_empty: bool) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return if allow_empty {
            Ok(PathBuf::new())
        } else {
            Err("A workspace-relative path is required.".to_string())
        };
    }
    let path = Path::new(trimmed);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Workspace paths must stay inside the mounted root.".to_string());
    }
    Ok(path.to_path_buf())
}

fn resolve_path(root: &Path, relative_path: &str, allow_empty: bool) -> Result<PathBuf, String> {
    let relative = validate_relative(relative_path, allow_empty)?;
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Workspace path is unavailable: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Workspace path escaped the mounted root.".to_string());
    }
    Ok(canonical)
}

fn resolve_write_target(
    root: &Path,
    relative_path: &str,
) -> Result<(String, PathBuf, PathBuf), String> {
    let relative = validate_relative(relative_path, false)?;
    let normalized = path_text(&relative);
    let candidate = root.join(&relative);
    let parent = candidate
        .parent()
        .ok_or_else(|| "Workspace write target requires a parent directory.".to_string())?
        .canonicalize()
        .map_err(|error| format!("Workspace parent directory is unavailable: {error}"))?;
    if !parent.starts_with(root) {
        return Err("Workspace path escaped the mounted root.".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(&candidate) {
        if metadata.file_type().is_symlink() {
            return Err("Workspace writes through symbolic links are not allowed.".to_string());
        }
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("Workspace write target is unavailable: {error}"))?;
        if !canonical.starts_with(root) {
            return Err("Workspace path escaped the mounted root.".to_string());
        }
    }
    Ok((normalized, candidate, parent))
}

fn move_entry_at(
    root: &Path,
    source_path: &str,
    target_path: &str,
) -> Result<NativeWorkspaceMoveResult, String> {
    let source_relative = validate_relative(source_path, false)?;
    let target_relative = validate_relative(target_path, false)?;
    let source_normalized = path_text(&source_relative);
    let target_normalized = path_text(&target_relative);
    if source_normalized == target_normalized {
        return Err("Workspace move source and target must be different.".to_string());
    }
    let source = root.join(&source_relative);
    let source_metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("Workspace move source is unavailable: {error}"))?;
    if source_metadata.file_type().is_symlink() {
        return Err("Workspace moves of symbolic links are not allowed.".to_string());
    }
    if !source_metadata.is_file() && !source_metadata.is_dir() {
        return Err("Workspace move source must be a file or directory.".to_string());
    }
    let source_canonical = source
        .canonicalize()
        .map_err(|error| format!("Workspace move source is unavailable: {error}"))?;
    if !source_canonical.starts_with(root) {
        return Err("Workspace path escaped the mounted root.".to_string());
    }
    let (_, target, parent) = resolve_write_target(root, &target_normalized)?;
    if target.exists() {
        return Err(
            "Workspace move target already exists; overwrite is not supported.".to_string(),
        );
    }
    if source_metadata.is_dir() && parent.starts_with(&source_canonical) {
        return Err("A workspace directory cannot be moved inside itself.".to_string());
    }
    fs::rename(&source, &target)
        .map_err(|error| format!("Workspace entry could not be moved: {error}"))?;
    Ok(NativeWorkspaceMoveResult {
        source_path: source_normalized,
        target_path: target_normalized,
        kind: if source_metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
    })
}

fn delete_entry_at(
    root: &Path,
    relative_path: &str,
) -> Result<NativeWorkspaceDeleteResult, String> {
    let relative = validate_relative(relative_path, false)?;
    let normalized = path_text(&relative);
    let target = root.join(&relative);
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| format!("Workspace delete target is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Workspace deletions of symbolic links are not allowed.".to_string());
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Workspace delete target must be a file or directory.".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("Workspace delete target is unavailable: {error}"))?;
    if !canonical.starts_with(root) || canonical == root {
        return Err("Workspace delete target must stay inside the mounted root.".to_string());
    }
    let kind = if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    if metadata.is_dir() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Workspace directory could not be deleted: {error}"))?;
    } else {
        fs::remove_file(&target)
            .map_err(|error| format!("Workspace file could not be deleted: {error}"))?;
    }
    Ok(NativeWorkspaceDeleteResult {
        relative_path: normalized,
        kind,
    })
}

fn apply_patch_at(
    root: &Path,
    relative_path: &str,
    expected_content: &str,
    updated_content: &str,
) -> Result<NativeWorkspacePatchResult, String> {
    let (normalized, target, _) = resolve_write_target(root, relative_path)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| format!("Workspace patch target is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("Workspace patches can only update regular text files.".to_string());
    }
    let current = fs::read_to_string(&target)
        .map_err(|error| format!("Workspace patch target is not readable UTF-8 text: {error}"))?;

    let final_content: String;

    if current == expected_content {
        final_content = updated_content.to_string();
    } else if current.replace("\r\n", "\n").trim() == expected_content.replace("\r\n", "\n").trim() {
        final_content = updated_content.to_string();
    } else if current.contains(expected_content) {
        let occurrences = current.matches(expected_content).count();
        if occurrences == 1 {
            final_content = current.replacen(expected_content, updated_content, 1);
        } else {
            return Err(format!(
                "Workspace patch ambiguous: target snippet was found {occurrences} times in the file. Include more surrounding lines."
            ));
        }
    } else {
        let norm_current = current.replace("\r\n", "\n");
        let norm_expected = expected_content.replace("\r\n", "\n");
        if norm_current.contains(&norm_expected) {
            let occurrences = norm_current.matches(&norm_expected).count();
            if occurrences == 1 {
                final_content = norm_current.replacen(&norm_expected, updated_content, 1);
            } else {
                return Err(format!(
                    "Workspace patch ambiguous: target snippet was found {occurrences} times in the file. Include more surrounding lines."
                ));
            }
        } else {
            return Err("Workspace patch is stale: expectedContent was not found in the target file. Read the file again before patching.".to_string());
        }
    }

    if current == final_content {
        return Ok(NativeWorkspacePatchResult {
            relative_path: normalized,
            kind: "file",
            created: false,
            bytes_written: Some(0),
            changed: false,
        });
    }

    write_file_at(root, relative_path, &final_content, true)?;
    Ok(NativeWorkspacePatchResult {
        relative_path: normalized,
        kind: "file",
        created: false,
        bytes_written: Some(final_content.as_bytes().len()),
        changed: true,
    })
}

fn create_directory_at(
    root: &Path,
    relative_path: &str,
) -> Result<NativeWorkspaceMutationResult, String> {
    let (normalized, target, _) = resolve_write_target(root, relative_path)?;
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_dir() => Ok(NativeWorkspaceMutationResult {
            relative_path: normalized,
            kind: "directory",
            created: false,
            bytes_written: None,
        }),
        Ok(_) => {
            Err("Workspace directory target already exists and is not a directory.".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&target)
                .map_err(|error| format!("Workspace directory could not be created: {error}"))?;
            Ok(NativeWorkspaceMutationResult {
                relative_path: normalized,
                kind: "directory",
                created: true,
                bytes_written: None,
            })
        }
        Err(error) => Err(format!(
            "Workspace directory target is unavailable: {error}"
        )),
    }
}

fn create_new_file(target: &Path, content: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("Workspace file could not be created: {error}"))?;
    if let Err(error) = file.write_all(content).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(target);
        return Err(format!("Workspace file could not be written: {error}"));
    }
    Ok(())
}

fn replace_file_atomically(target: &Path, parent: &Path, content: &[u8]) -> Result<(), String> {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Workspace file name is unavailable.".to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is unavailable.".to_string())?
        .as_nanos();
    let temporary = parent.join(format!(".{name}.iris-{nonce}-{}", std::process::id()));
    create_new_file(&temporary, content)?;
    if let Ok(metadata) = fs::metadata(target) {
        if let Err(error) = fs::set_permissions(&temporary, metadata.permissions()) {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Workspace file permissions could not be preserved: {error}"
            ));
        }
    }
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Workspace file could not be replaced atomically: {error}"
        ));
    }
    Ok(())
}

fn write_file_at(
    root: &Path,
    relative_path: &str,
    content: &str,
    overwrite: bool,
) -> Result<NativeWorkspaceMutationResult, String> {
    let bytes = content.as_bytes();
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Workspace file content exceeds the {MAX_WRITE_BYTES} byte write limit."
        ));
    }
    let (normalized, target, parent) = resolve_write_target(root, relative_path)?;
    let existing = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("Workspace write target is not a regular file.".to_string());
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Workspace write target is unavailable: {error}")),
    };
    if existing && !overwrite {
        return Err(
            "Workspace file already exists. Set overwrite to true only when replacement is intended."
                .to_string(),
        );
    }
    if existing {
        replace_file_atomically(&target, &parent, bytes)?;
    } else {
        create_new_file(&target, bytes)?;
    }
    Ok(NativeWorkspaceMutationResult {
        relative_path: normalized,
        kind: "file",
        created: !existing,
        bytes_written: Some(bytes.len()),
    })
}

fn mounted_root(state: &State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    state
        .0
        .read()
        .map_err(|_| "Workspace state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "No local workspace is mounted.".to_string())
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn entry_kind(file_type: &fs::FileType) -> &'static str {
    if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "file"
    }
}

fn list_directory(
    root: &Path,
    directory: &Path,
    relative_path: &str,
) -> Result<NativeWorkspaceListing, String> {
    if !directory.is_dir() {
        return Err("Workspace list target is not a directory.".to_string());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Workspace directory could not be read: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let metadata = entry.metadata().ok();
            Some(NativeWorkspaceEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                relative_path: relative_text(root, &entry.path()).ok()?,
                kind: entry_kind(&file_type),
                size: metadata
                    .as_ref()
                    .filter(|_| file_type.is_file())
                    .map(fs::Metadata::len),
                modified_at_ms: metadata.as_ref().and_then(modified_ms),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(
        |left, right| match (left.kind == "directory", right.kind == "directory") {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        },
    );
    let truncated = entries.len() > LIST_LIMIT;
    entries.truncate(LIST_LIMIT);
    Ok(NativeWorkspaceListing {
        relative_path: relative_path.to_string(),
        entries,
        truncated,
    })
}

fn utf8_content(mut bytes: Vec<u8>, truncated: bool) -> Result<String, String> {
    if truncated {
        while std::str::from_utf8(&bytes).is_err() && bytes.len() > 1 {
            bytes.pop();
        }
    }
    String::from_utf8(bytes).map_err(|_| "Workspace file is not UTF-8 text.".to_string())
}

fn read_limited(file: fs::File, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::with_capacity(limit.min(DEFAULT_READ_BYTES));
    let mut reader: Take<fs::File> = file.take((limit + 1) as u64);
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Workspace file could not be read: {error}"))?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    Ok((bytes, truncated))
}

#[tauri::command]
pub fn mount_workspace(
    state: State<'_, WorkspaceState>,
    root_path: String,
) -> Result<NativeWorkspaceMount, String> {
    let canonical = PathBuf::from(root_path.trim())
        .canonicalize()
        .map_err(|error| format!("Workspace folder is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err("Workspace root must be a directory.".to_string());
    }
    let name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path_text(&canonical));
    *state
        .0
        .write()
        .map_err(|_| "Workspace state is unavailable.".to_string())? = Some(canonical.clone());
    Ok(NativeWorkspaceMount {
        name,
        root_path: path_text(&canonical),
    })
}

#[tauri::command]
pub fn unmount_workspace(state: State<'_, WorkspaceState>) -> Result<(), String> {
    *state
        .0
        .write()
        .map_err(|_| "Workspace state is unavailable.".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn list_workspace(
    state: State<'_, WorkspaceState>,
    relative_path: Option<String>,
) -> Result<NativeWorkspaceListing, String> {
    let root = mounted_root(&state)?;
    let relative = relative_path.unwrap_or_default();
    let directory = resolve_path(&root, &relative, true)?;
    list_directory(&root, &directory, &relative)
}

#[tauri::command]
pub fn read_workspace_file(
    state: State<'_, WorkspaceState>,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<NativeWorkspaceTextFile, String> {
    let root = mounted_root(&state)?;
    let normalized = path_text(&validate_relative(&relative_path, false)?);
    let path = resolve_path(&root, &normalized, false)?;
    if !path.is_file() {
        return Err("Workspace read target is not a file.".to_string());
    }
    let limit = max_bytes
        .unwrap_or(DEFAULT_READ_BYTES)
        .clamp(1, MAX_READ_BYTES);
    let (bytes, truncated) = read_limited(
        fs::File::open(path)
            .map_err(|error| format!("Workspace file could not be opened: {error}"))?,
        limit,
    )?;
    let bytes_read = bytes.len();
    Ok(NativeWorkspaceTextFile {
        relative_path: normalized,
        content: utf8_content(bytes, truncated)?,
        bytes_read,
        truncated,
    })
}

fn search_root(
    root: &Path,
    query: &str,
    max_results: Option<usize>,
) -> Result<NativeWorkspaceSearchResult, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err("Workspace search requires a query of at most 200 characters.".to_string());
    }
    let query_lower = query.to_lowercase();
    let result_limit = max_results.unwrap_or(40).clamp(1, 100);
    let mut matches = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut scanned_entries = 0;

    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.filter_map(Result::ok) {
            if scanned_entries >= SEARCH_ENTRY_LIMIT || matches.len() >= result_limit {
                return Ok(NativeWorkspaceSearchResult {
                    query: query.to_string(),
                    matches,
                    scanned_entries,
                    truncated: true,
                });
            }
            scanned_entries += 1;
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let relative_path = match relative_text(root, &path) {
                Ok(path) => path,
                Err(_) => continue,
            };
            if relative_path.to_lowercase().contains(&query_lower) {
                matches.push(NativeWorkspaceSearchMatch {
                    relative_path: relative_path.clone(),
                    r#match: "path",
                    line: None,
                    preview: relative_path.clone(),
                });
            }
            if matches.len() >= result_limit {
                continue;
            }
            if !matches!(entry.metadata(), Ok(metadata) if metadata.len() <= SEARCH_FILE_BYTES) {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let content = match std::str::from_utf8(&bytes) {
                Ok(content) => content,
                Err(_) => continue,
            };
            if let Some((line_index, line)) = content
                .lines()
                .enumerate()
                .find(|(_, line)| line.to_lowercase().contains(&query_lower))
            {
                matches.push(NativeWorkspaceSearchMatch {
                    relative_path,
                    r#match: "content",
                    line: Some(line_index + 1),
                    preview: line.trim().chars().take(240).collect(),
                });
            }
        }
    }

    Ok(NativeWorkspaceSearchResult {
        query: query.to_string(),
        matches,
        scanned_entries,
        truncated: false,
    })
}

#[tauri::command]
pub fn search_workspace(
    state: State<'_, WorkspaceState>,
    query: String,
    max_results: Option<usize>,
) -> Result<NativeWorkspaceSearchResult, String> {
    let root = mounted_root(&state)?;
    search_root(&root, &query, max_results)
}

#[tauri::command]
pub fn create_workspace_directory(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<NativeWorkspaceMutationResult, String> {
    let root = mounted_root(&state)?;
    create_directory_at(&root, &relative_path)
}

#[tauri::command]
pub fn write_workspace_file(
    state: State<'_, WorkspaceState>,
    relative_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<NativeWorkspaceMutationResult, String> {
    let root = mounted_root(&state)?;
    write_file_at(&root, &relative_path, &content, overwrite.unwrap_or(false))
}

#[tauri::command]
pub fn move_workspace_entry(
    state: State<'_, WorkspaceState>,
    source_path: String,
    target_path: String,
) -> Result<NativeWorkspaceMoveResult, String> {
    let root = mounted_root(&state)?;
    move_entry_at(&root, &source_path, &target_path)
}

#[tauri::command]
pub fn delete_workspace_entry(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<NativeWorkspaceDeleteResult, String> {
    let root = mounted_root(&state)?;
    delete_entry_at(&root, &relative_path)
}

#[tauri::command]
pub fn apply_workspace_patch(
    state: State<'_, WorkspaceState>,
    relative_path: String,
    expected_content: String,
    updated_content: String,
) -> Result<NativeWorkspacePatchResult, String> {
    let root = mounted_root(&state)?;
    apply_patch_at(&root, &relative_path, &expected_content, &updated_content)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceGitStatus {
    pub is_git_repo: bool,
    pub branch: String,
    pub has_changes: bool,
    pub modified_files: Vec<String>,
    pub untracked_files: Vec<String>,
    pub staged_files: Vec<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[tauri::command]
pub fn workspace_git_status(
    state: State<'_, WorkspaceState>,
) -> Result<NativeWorkspaceGitStatus, String> {
    let root = mounted_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(NativeWorkspaceGitStatus {
            is_git_repo: false,
            branch: String::new(),
            has_changes: false,
            modified_files: Vec::new(),
            untracked_files: Vec::new(),
            staged_files: Vec::new(),
            ahead: 0,
            behind: 0,
        });
    }

    let branch = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&root)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_else(|_| "main".to_string());

    let status_output = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
        .unwrap_or_default();

    let mut modified_files = Vec::new();
    let mut untracked_files = Vec::new();
    let mut staged_files = Vec::new();

    for line in status_output.lines() {
        if line.len() < 3 {
            continue;
        }
        let index_status = line.chars().next().unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let filename = line[3..].trim().to_string();

        if index_status == '?' && worktree_status == '?' {
            untracked_files.push(filename);
        } else {
            if index_status != ' ' && index_status != '?' {
                staged_files.push(filename.clone());
            }
            if worktree_status != ' ' && worktree_status != '?' {
                modified_files.push(filename);
            }
        }
    }

    let has_changes =
        !modified_files.is_empty() || !untracked_files.is_empty() || !staged_files.is_empty();

    Ok(NativeWorkspaceGitStatus {
        is_git_repo: true,
        branch,
        has_changes,
        modified_files,
        untracked_files,
        staged_files,
        ahead: 0,
        behind: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_patch_at, create_directory_at, delete_entry_at, list_directory, move_entry_at,
        resolve_path, search_root, utf8_content, write_file_at,
    };
    use std::{fs, path::PathBuf, time::SystemTime};

    fn test_root() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iris-workspace-test-{unique}"));
        fs::create_dir_all(root.join("src")).expect("create test workspace");
        fs::write(root.join("src/main.ts"), "export const iris = true;\n")
            .expect("write test file");
        root.canonicalize().expect("canonical root")
    }

    #[test]
    fn rejects_paths_outside_the_mounted_root() {
        let root = test_root();
        assert!(resolve_path(&root, "../outside", false).is_err());
        assert!(resolve_path(&root, "/etc/passwd", false).is_err());
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn lists_real_entries_with_workspace_relative_paths() {
        let root = test_root();
        let listing = list_directory(&root, &root, "").expect("list workspace");
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].relative_path, "src");
        assert_eq!(listing.entries[0].kind, "directory");
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn refuses_non_utf8_file_content() {
        assert!(utf8_content(vec![0xff, 0xfe], false).is_err());
    }

    #[test]
    fn searches_real_utf8_content_with_relative_results() {
        let root = test_root();
        let result = search_root(&root, "iris", Some(10)).expect("search workspace");
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].relative_path, "src/main.ts");
        assert_eq!(result.matches[0].r#match, "content");
        assert_eq!(result.matches[0].line, Some(1));
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn creates_directories_and_files_only_inside_the_workspace() {
        let root = test_root();
        let directory = create_directory_at(&root, "notes").expect("create directory");
        assert!(directory.created);
        assert!(root.join("notes").is_dir());

        let file =
            write_file_at(&root, "notes/hello.txt", "Hej IRIS\n", false).expect("create file");
        assert!(file.created);
        assert_eq!(file.bytes_written, Some(9));
        assert_eq!(
            fs::read_to_string(root.join("notes/hello.txt")).expect("read file"),
            "Hej IRIS\n"
        );
        assert!(create_directory_at(&root, "../outside").is_err());
        assert!(write_file_at(&root, "../outside.txt", "no", false).is_err());
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn requires_explicit_overwrite_and_replaces_existing_files() {
        let root = test_root();
        assert!(write_file_at(&root, "src/main.ts", "changed\n", false).is_err());
        let result =
            write_file_at(&root, "src/main.ts", "changed\n", true).expect("overwrite file");
        assert!(!result.created);
        assert_eq!(
            fs::read_to_string(root.join("src/main.ts")).expect("read overwritten file"),
            "changed\n"
        );
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn moves_files_and_directories_without_overwriting_or_escaping() {
        let root = test_root();
        fs::create_dir(root.join("archive")).expect("create archive");
        let file = move_entry_at(&root, "src/main.ts", "archive/main.ts").expect("move file");
        assert_eq!(file.source_path, "src/main.ts");
        assert_eq!(file.target_path, "archive/main.ts");
        assert_eq!(file.kind, "file");
        assert!(root.join("archive/main.ts").is_file());
        assert!(move_entry_at(&root, "archive/main.ts", "archive/main.ts").is_err());
        assert!(move_entry_at(&root, "archive/main.ts", "archive/missing/main.ts").is_err());
        fs::create_dir(root.join("folder")).expect("create folder");
        assert!(move_entry_at(&root, "folder", "folder/child").is_err());
        assert!(move_entry_at(&root, "archive/main.ts", "../outside").is_err());
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn deletes_files_and_directories_without_following_symlinks_or_escaping() {
        let root = test_root();
        let file = delete_entry_at(&root, "src/main.ts").expect("delete file");
        assert_eq!(file.relative_path, "src/main.ts");
        assert_eq!(file.kind, "file");
        assert!(!root.join("src/main.ts").exists());
        fs::create_dir_all(root.join("build/nested")).expect("create directory");
        fs::write(root.join("build/nested/output.txt"), "output").expect("write output");
        let directory = delete_entry_at(&root, "build").expect("delete directory");
        assert_eq!(directory.kind, "directory");
        assert!(!root.join("build").exists());
        assert!(delete_entry_at(&root, "../outside").is_err());
        fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn applies_only_fresh_text_patches() {
        let root = test_root();
        let result = apply_patch_at(
            &root,
            "src/main.ts",
            "export const iris = true;\n",
            "export const iris = false;\n",
        )
        .expect("patch file");
        assert!(result.changed);
        assert_eq!(
            fs::read_to_string(root.join("src/main.ts")).expect("read"),
            "export const iris = false;\n"
        );
        // Test snippet replacement
        let result_snippet = apply_patch_at(
            &root,
            "src/main.ts",
            "iris = false",
            "iris = true",
        )
        .expect("snippet patch file");
        assert!(result_snippet.changed);
        assert_eq!(
            fs::read_to_string(root.join("src/main.ts")).expect("read"),
            "export const iris = true;\n"
        );
        assert!(apply_patch_at(&root, "src/main.ts", "stale_snippet_not_found", "new").is_err());
        fs::remove_dir_all(root).expect("remove test workspace");
    }
}
