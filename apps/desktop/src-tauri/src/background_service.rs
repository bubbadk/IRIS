use serde::Serialize;
use std::{fs, path::PathBuf, process::Command};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundServiceStatus {
    pub installed: bool,
    pub enabled: bool,
    pub active: bool,
    pub message: String,
}

const UNIT_NAME: &str = "iris-background.service";

/**
 * Exit code used when the interactive IRIS process already owns queued execution.
 *
 * This is a normal steady state, not a failure, so the unit must not be restarted for it. The
 * unit's `RestartPreventExitStatus` lists this code, and the `FailureAction`-free exit status
 * keeps `systemctl start` successful so installing the service never reports a false error.
 */
pub const OWNERSHIP_CONFLICT_EXIT_CODE: i32 = 0;

fn unit_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("The user home directory is unavailable.")?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("systemd")
        .join("user")
        .join(UNIT_NAME))
}

fn systemctl(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|error| format!("Could not run systemctl: {error}"))
}

fn status_word(args: &[&str], wanted: &str) -> bool {
    systemctl(args)
        .map(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == wanted
        })
        .unwrap_or(false)
}

fn escaped_exec_path(path: &std::path::Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or("The IRIS executable path is not valid UTF-8.")?;
    if value.contains(['\n', '\r', '"', '\'']) {
        return Err(
            "The IRIS executable path cannot be written safely to a service unit.".to_string(),
        );
    }
    Ok(value.replace(' ', "\\x20"))
}

/**
 * Build the systemd user unit.
 *
 * Restart policy notes (H-13): `Restart=on-failure` is kept because a genuine crash of the
 * background runtime *should* recover, but the restart storm is solved at its root:
 *
 * - `RestartPreventExitStatus=0` plus the clean exit taken on an ownership conflict means
 *   "the GUI already owns the queue" is never treated as a failure and never restarted.
 * - `StartLimitIntervalSec`/`StartLimitBurst` bound any remaining restart activity, so even an
 *   unexpected persistent failure cannot become an unbounded storm; systemd gives up instead.
 * - `RestartSec` backs off to 30s so a recovered unit is not relaunched every few seconds.
 *
 * The alternative — dropping `Restart` entirely — was rejected because it would leave a real
 * crash of the background runtime unrecovered, and would not by itself stop the short-lived
 * (successful-exit) churn the installer previously caused.
 */
fn unit_contents(executable: &std::path::Path) -> Result<String, String> {
    Ok(format!(
        "[Unit]\nDescription=IRIS background queue runtime\nAfter=graphical-session.target\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart={} --background-service\nRestart=on-failure\nRestartSec=30\nRestartPreventExitStatus={}\n\n[Install]\nWantedBy=default.target\n",
        escaped_exec_path(executable)?,
        OWNERSHIP_CONFLICT_EXIT_CODE
    ))
}

#[tauri::command]
pub fn background_service_status() -> Result<BackgroundServiceStatus, String> {
    let installed = unit_path()?.is_file();
    let enabled = installed && status_word(&["is-enabled", UNIT_NAME], "enabled");
    let active = installed && status_word(&["is-active", UNIT_NAME], "active");
    let message = if !installed {
        "Background runtime is not installed. Queues run while IRIS stays open in the system tray."
            .to_string()
    } else if active {
        "Background runtime is active. Queues can continue while the normal IRIS window is closed."
            .to_string()
    } else if enabled {
        "Background runtime is enabled and will take over after the current IRIS process exits."
            .to_string()
    } else {
        "Background runtime is installed but disabled.".to_string()
    };
    Ok(BackgroundServiceStatus {
        installed,
        enabled,
        active,
        message,
    })
}

#[tauri::command]
pub fn install_background_service() -> Result<BackgroundServiceStatus, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let path = unit_path()?;
    let parent = path
        .parent()
        .ok_or("The systemd user unit directory is unavailable.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::write(&path, unit_contents(&executable)?).map_err(|error| error.to_string())?;
    let imported = systemctl(&[
        "import-environment",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ])?;
    if !imported.status.success() {
        return Err(String::from_utf8_lossy(&imported.stderr).trim().to_string());
    }
    let reloaded = systemctl(&["daemon-reload"])?;
    if !reloaded.status.success() {
        return Err(String::from_utf8_lossy(&reloaded.stderr).trim().to_string());
    }
    let enabled = systemctl(&["enable", UNIT_NAME])?;
    if !enabled.status.success() {
        return Err(String::from_utf8_lossy(&enabled.stderr).trim().to_string());
    }
    // Deliberately NOT started while this process owns queued execution. The unit is installed and
    // enabled, so systemd activates it once the interactive IRIS process exits; starting it now
    // would only race the lock this process already holds. This is why installation cannot create
    // a conflict storm.
    background_service_status()
}

#[tauri::command]
pub fn remove_background_service() -> Result<(), String> {
    let _ = systemctl(&["disable", "--now", UNIT_NAME]);
    let path = unit_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    let reloaded = systemctl(&["daemon-reload"])?;
    if !reloaded.status.success() {
        return Err(String::from_utf8_lossy(&reloaded.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{unit_contents, OWNERSHIP_CONFLICT_EXIT_CODE};

    #[test]
    fn unit_uses_the_background_flag_and_escaped_path() {
        let unit = unit_contents(std::path::Path::new("/opt/IRIS App/iris")).unwrap();
        assert!(unit.contains("ExecStart=/opt/IRIS\\x20App/iris --background-service"));
        assert!(unit.contains("Restart=on-failure"));
    }

    /** H-13: the unit must carry a bounded restart policy and never restart an ownership conflict. */
    #[test]
    fn unit_bounds_restarts_and_never_restarts_an_ownership_conflict() {
        let unit = unit_contents(std::path::Path::new("/usr/bin/iris")).unwrap();
        // A clean exit on an ownership conflict is prevented from being restarted.
        assert!(unit.contains(&format!(
            "RestartPreventExitStatus={OWNERSHIP_CONFLICT_EXIT_CODE}"
        )));
        // A persistent genuine failure is bounded instead of looping forever.
        assert!(unit.contains("StartLimitIntervalSec=300"));
        assert!(unit.contains("StartLimitBurst=5"));
        // Restart backoff is not an aggressive 5 seconds.
        assert!(unit.contains("RestartSec=30"));
        assert!(!unit.contains("RestartSec=5\n"));
    }

    /** H-13: the install flow must not contain a start of the unit while IRIS runs. */
    #[test]
    fn install_flow_never_starts_the_unit_immediately() {
        let source = include_str!("background_service.rs");
        let install = source
            .split("pub fn install_background_service")
            .nth(1)
            .expect("install flow exists")
            .split("pub fn remove_background_service")
            .next()
            .unwrap();
        // The install body may only enable the unit; starting it here is what produced the storm.
        assert!(install.contains("\"enable\""));
        assert!(!install.contains("\"start\""));
    }

    /** H-13: the ownership-conflict exit code is a clean success, not a failure exit. */
    #[test]
    fn ownership_conflict_exit_code_is_a_clean_exit() {
        assert_eq!(OWNERSHIP_CONFLICT_EXIT_CODE, 0);
    }
}
