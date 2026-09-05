//! Durable repository documents. Optimistic revisions protect calls across webviews/processes.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::Duration};
use tauri::Manager;

type Values = BTreeMap<String, String>;
type Revisions = BTreeMap<String, i64>;
type Changes = BTreeMap<String, Option<String>>;

#[derive(Serialize, Debug)]
pub struct Snapshot { values: Values, revisions: Revisions }

fn allowed_keys() -> Vec<String> {
    serde_json::from_str(include_str!("../../src/repositoryKeys.json")).expect("valid repository key registry")
}
fn validate_keys<'a>(keys: impl Iterator<Item = &'a String>) -> Result<(), String> {
    let allowed = allowed_keys();
    if keys.into_iter().any(|key| !allowed.contains(key)) {
        return Err("Unknown repository key.".into());
    }
    Ok(())
}
fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);").map_err(|e| e.to_string())?;
    Ok(connection)
}
fn initialize(path: &Path, legacy: Values) -> Result<(), String> {
    validate_keys(legacy.keys())?;
    let mut connection = open(path)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let migrated: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='localstorage-v1')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !migrated {
        for (key, value) in legacy {
            // Abort the entire migration on corrupt JSON; never mark partial import complete.
            serde_json::from_str::<serde_json::Value>(&value).map_err(|_| format!("Existing data for {key} is not valid JSON. Migration stopped; the source is unchanged."))?;
            tx.execute("INSERT INTO documents(key,value,revision) VALUES(?1,?2,1) ON CONFLICT(key) DO NOTHING", params![key, value]).map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO migrations(name) VALUES('localstorage-v1')", []).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
fn snapshot(path: &Path, keys: Option<Vec<String>>) -> Result<Snapshot, String> {
    let keys = keys.unwrap_or_else(allowed_keys);
    validate_keys(keys.iter())?;
    let connection = open(path)?;
    let query = format!("SELECT key,value,revision FROM documents WHERE key IN ({})", vec!["?"; keys.len()].join(","));
    let mut statement = connection.prepare(&query).map_err(|e| e.to_string())?;
    let rows = statement.query_map(rusqlite::params_from_iter(keys), |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?))).map_err(|e| e.to_string())?;
    let mut result = Snapshot { values: Values::new(), revisions: Revisions::new() };
    for row in rows {
        let (key, value, revision) = row.map_err(|e| e.to_string())?;
        result.revisions.insert(key.clone(), revision);
        if let Some(value) = value { result.values.insert(key, value); }
    }
    Ok(result)
}
fn commit(path: &Path, expected: Revisions, changes: Changes) -> Result<bool, String> {
    validate_keys(expected.keys())?;
    validate_keys(changes.keys())?;
    if changes.keys().any(|key| !expected.contains_key(key)) { return Err("Every write requires an expected revision.".into()); }
    let mut connection = open(path)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    for (key, revision) in expected {
        let actual: i64 = tx.query_row("SELECT revision FROM documents WHERE key=?1", [&key], |row| row.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
        if actual != revision { return Ok(false); }
    }
    for (key, value) in changes {
        // Keep tombstones so deleting/recreating a document cannot evade revision checks.
        tx.execute("INSERT INTO documents(key,value,revision) VALUES(?1,?2,1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=documents.revision+1", params![key, value]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}
fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("repositories.sqlite3"))
}
#[tauri::command]
pub async fn repository_initialize(app: tauri::AppHandle, legacy: Values) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || initialize(&path, legacy)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn repository_snapshot(app: tauri::AppHandle, keys: Option<Vec<String>>) -> Result<Snapshot, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || snapshot(&path, keys)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn repository_commit(app: tauri::AppHandle, expected: Revisions, changes: Changes) -> Result<bool, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || commit(&path, expected, changes)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "iris.tools.approvals.v1";
    struct Database(PathBuf);
    impl Database {
        fn new() -> Self {
            static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!("iris-repository-test-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            std::fs::create_dir_all(&dir).unwrap(); Self(dir.join("test.sqlite3"))
        }
    }
    impl Drop for Database { fn drop(&mut self) { let _ = std::fs::remove_dir_all(self.0.parent().unwrap()); } }
    fn values(value: &str) -> Values { BTreeMap::from([(KEY.into(), value.into())]) }
    fn revisions(version: i64) -> Revisions { BTreeMap::from([(KEY.into(), version)]) }
    fn changes(value: Option<&str>) -> Changes { BTreeMap::from([(KEY.into(), value.map(str::to_owned))]) }
    #[test]
    fn migration_survives_reopen_and_does_not_resurrect_deleted_data() {
        let db = Database::new(); initialize(&db.0, values("[]")).unwrap();
        assert_eq!(snapshot(&db.0, None).unwrap().values[KEY], "[]");
        assert!(commit(&db.0, revisions(1), changes(None)).unwrap());
        initialize(&db.0, values("[\"stale backup\"]")).unwrap();
        assert!(!snapshot(&db.0, None).unwrap().values.contains_key(KEY));
        assert!(!commit(&db.0, revisions(0), changes(Some("[]"))).unwrap());
    }
    #[test]
    fn corrupt_import_rolls_back_all_documents_and_can_be_retried() {
        let db = Database::new();
        let legacy = BTreeMap::from([("iris.agents.config.v2".into(), "[]".into()), (KEY.into(), "broken".into())]);
        assert!(initialize(&db.0, legacy).is_err());
        assert!(snapshot(&db.0, None).unwrap().values.is_empty());
        initialize(&db.0, values("[]")).unwrap();
        assert_eq!(snapshot(&db.0, None).unwrap().values[KEY], "[]");
    }
    #[test]
    fn two_connections_can_claim_an_approval_only_once() {
        let db = Database::new(); initialize(&db.0, values("[\"approved\"]")).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2).map(|_| {
            let path = db.0.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); commit(&path, revisions(1), changes(Some("[\"executing\"]"))).unwrap() })
        }).collect();
        assert_eq!(threads.into_iter().map(|t| usize::from(t.join().unwrap())).sum::<usize>(), 1);
        assert_eq!(snapshot(&db.0, None).unwrap().revisions[KEY], 2);
    }
    #[test]
    fn stale_multi_document_update_changes_nothing() {
        let db = Database::new(); initialize(&db.0, values("[]")).unwrap();
        let expected = BTreeMap::from([(KEY.into(), 0), ("iris.memory.records.v1".into(), 0)]);
        let updates = BTreeMap::from([(KEY.into(), Some("[1]".into())), ("iris.memory.records.v1".into(), Some("[2]".into()))]);
        assert!(!commit(&db.0, expected, updates).unwrap());
        assert_eq!(snapshot(&db.0, None).unwrap().values, values("[]"));
    }
}
