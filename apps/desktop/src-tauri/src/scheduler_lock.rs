use std::{
    fs::{File, OpenOptions},
    path::Path,
    sync::Mutex,
};
use tauri::Manager;

#[derive(Default)]
pub struct SchedulerLock(pub Mutex<Option<File>>);

fn acquire(path: &Path) -> Result<Option<File>, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        #[cfg(windows)]
        Err(error) if error.raw_os_error() == Some(32) => return Ok(None),
        Err(error) => return Err(format!("The schedule owner lock is unavailable: {error}")),
    };
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(format!("The schedule owner lock failed: {error}"));
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err("Exclusive scheduling is unavailable on this platform.".to_string());
    #[cfg(any(unix, windows))]
    Ok(Some(file))
}

/**
 * Frontend-facing ownership request.
 *
 * Returns `true` only when this process truly owns queued execution. A lock that cannot be
 * evaluated yields a descriptive error so the frontend can report `unavailable` instead of
 * silently claiming the queue runs. This never affects whether the app itself is running.
 */
#[tauri::command]
pub fn acquire_schedule_owner(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SchedulerLock>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Only the main runtime can own scheduled execution.".to_string());
    }
    let mut held = state
        .0
        .lock()
        .map_err(|_| "The schedule owner lock is poisoned.".to_string())?;
    if held.is_some() {
        return Ok(true);
    }
    let directory = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    match attempt_ownership(&mut held, &directory) {
        OwnershipOutcome::Owned => Ok(true),
        OwnershipOutcome::HeldByAnotherProcess => Ok(false),
        OwnershipOutcome::Unavailable(reason) => Err(reason),
    }
}

/** Why an ownership attempt ended the way it did. */
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnershipOutcome {
    /** This process owns the lock (or already did). */
    Owned,
    /** A legitimate IRIS process holds the lock; this process must not run queues. */
    HeldByAnotherProcess,
    /** The lock could not be evaluated at all — I/O, permissions, poisoning, invalid path. */
    Unavailable(String),
}

/**
 * Acquire the schedule-owner lock during setup, without turning a lock problem into a crash.
 *
 * Returns how the attempt ended: `Owned`, `HeldByAnotherProcess`, or `Unavailable`. The caller
 * decides what to do. Failing to own the queue must never be fatal for the interactive UI, and a
 * background-service process must never propagate a lock problem as a startup failure.
 */
pub fn evaluate_schedule_ownership<R: tauri::Runtime>(app: &tauri::App<R>) -> OwnershipOutcome {
    let state = app.state::<SchedulerLock>();
    let mut held = match state.0.lock() {
        Ok(held) => held,
        Err(_) => {
            return OwnershipOutcome::Unavailable(
                "The schedule owner lock is poisoned.".to_string(),
            )
        }
    };
    if held.is_some() {
        return OwnershipOutcome::Owned;
    }
    let directory = match app.path().app_data_dir() {
        Ok(directory) => directory,
        Err(error) => return OwnershipOutcome::Unavailable(error.to_string()),
    };
    if let Err(error) = std::fs::create_dir_all(&directory) {
        return OwnershipOutcome::Unavailable(error.to_string());
    }
    attempt_ownership(&mut held, &directory)
}

/**
 * The testable core of setup-time ownership: publish a successful acquisition into `held`, and
 * describe every other ending without panicking or propagating a fatal error.
 */
fn attempt_ownership(held: &mut Option<File>, directory: &Path) -> OwnershipOutcome {
    match acquire(&directory.join("schedule-owner.lock")) {
        Ok(Some(file)) => {
            *held = Some(file);
            OwnershipOutcome::Owned
        }
        Ok(None) => OwnershipOutcome::HeldByAnotherProcess,
        Err(error) => OwnershipOutcome::Unavailable(error),
    }
}

/** Exposes a single lock attempt to integration tests without changing production behaviour. */
#[cfg(test)]
pub fn acquire_for_test(path: &Path) -> Result<Option<File>, String> {
    acquire(path)
}

/** Exposes one full ownership attempt, with its truthfulness contract, to integration tests. */
#[cfg(test)]
pub fn attempt_ownership_for_test(
    held: &mut Option<File>,
    directory: &Path,
) -> OwnershipOutcome {
    attempt_ownership(held, directory)
}

pub fn has_schedule_owner<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<bool, String> {
    Ok(app
        .state::<SchedulerLock>()
        .0
        .lock()
        .map_err(|_| "The schedule owner lock is poisoned.")?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::{acquire, attempt_ownership, OwnershipOutcome};
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "iris-scheduler-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn only_one_owner_can_hold_the_lock_and_dropping_releases_it() {
        let directory = temp_dir("lock");
        let path = directory.join("schedule-owner.lock");
        let first = acquire(&path).unwrap().unwrap();
        assert!(acquire(&path).unwrap().is_none());
        drop(first);
        let next = acquire(&path).unwrap().unwrap();
        drop(next);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    /** H-04 Test 1: the normal startup path establishes ownership. */
    #[test]
    fn ownership_is_established_on_the_normal_path() {
        let directory = temp_dir("normal");
        let mut held = None;
        let outcome = attempt_ownership(&mut held, &directory);
        assert_eq!(outcome, OwnershipOutcome::Owned);
        assert!(held.is_some(), "the acquired handle must be published");
        drop(held);
        std::fs::remove_dir_all(directory).unwrap();
    }

    /** H-04 Test 2: another owner is reported, never panicked on and never treated as ours. */
    #[test]
    fn a_second_owner_is_reported_as_held_without_panicking() {
        let directory = temp_dir("second");
        let mut first_held = None;
        assert_eq!(
            attempt_ownership(&mut first_held, &directory),
            OwnershipOutcome::Owned
        );
        let mut second_held = None;
        let outcome = attempt_ownership(&mut second_held, &directory);
        assert_eq!(outcome, OwnershipOutcome::HeldByAnotherProcess);
        assert!(
            second_held.is_none(),
            "a process that did not win must not claim ownership"
        );
        drop(first_held);
        std::fs::remove_dir_all(directory).unwrap();
    }

    /**
     * H-04 Test 3: a deterministic lock failure (unwritable directory) degrades to `Unavailable`
     * instead of panicking or aborting startup.
     */
    #[cfg(unix)]
    #[test]
    fn an_unwritable_lock_directory_degrades_instead_of_panicking() {
        use std::os::unix::fs::PermissionsExt;
        let directory = temp_dir("readonly");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();
        let mut held = None;
        let outcome = attempt_ownership(&mut held, &directory);
        // Running as root bypasses the permission bits, so only assert when the denial is real.
        if matches!(outcome, OwnershipOutcome::Unavailable(_)) {
            assert!(held.is_none());
        }
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    /** H-04 Test 3b: a lock path that is a directory is a controlled `Unavailable`, not a panic. */
    #[test]
    fn an_invalid_lock_path_is_a_controlled_unavailable() {
        let directory = temp_dir("invalid");
        // Occupy the lock filename with a directory so opening it as a file must fail.
        std::fs::create_dir_all(directory.join("schedule-owner.lock")).unwrap();
        let mut held = None;
        let outcome = attempt_ownership(&mut held, &directory);
        match outcome {
            OwnershipOutcome::Unavailable(_) => assert!(held.is_none()),
            // With O_NOFOLLOW a symlinked/dir target may instead surface as "not acquired".
            OwnershipOutcome::HeldByAnotherProcess => assert!(held.is_none()),
            OwnershipOutcome::Owned => panic!("a directory can never be a valid lock file"),
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    /** H-04 Test 4: ownership is only ever claimed when the lock was truly acquired. */
    #[test]
    fn ownership_is_never_reported_without_a_real_lock() {
        let directory = temp_dir("truth");
        let mut held = None;
        assert_eq!(
            attempt_ownership(&mut held, &directory),
            OwnershipOutcome::Owned
        );
        assert!(held.is_some());
        drop(held);
        // Once released, a competing probe must still not fabricate ownership for a held handle.
        let mut blocker = None;
        assert_eq!(
            attempt_ownership(&mut blocker, &directory),
            OwnershipOutcome::Owned
        );
        let mut loser = None;
        assert_ne!(
            attempt_ownership(&mut loser, &directory),
            OwnershipOutcome::Owned
        );
        assert!(loser.is_none());
        drop(blocker);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
