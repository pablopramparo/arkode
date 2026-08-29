//! `arkode-scheduler` — the Windows service that runs arkode's scheduled
//! backups. Deliberately thin: it owns no DB or backup logic. Every 60 s it
//! shells out to the vendored `engine-cli.exe scheduler:tick`, which runs
//! every due DB-backup task, every due file-backup task, any due repository
//! maintenance, and stamps a heartbeat the app reads to show "is scheduling
//! alive?". Installed + started by the (already-elevated) NSIS installer, so
//! there is no per-task UAC anywhere. Runs as LocalSystem — parity with the
//! `S-1-5-18` Scheduled Tasks it replaces.
//!
//! `arkode-scheduler --once` runs a single tick in the console and exits,
//! bypassing the SCM entirely — for local testing without an install.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const SERVICE_NAME: &str = "arkode-scheduler";
const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// CREATE_NO_WINDOW — the child engine-cli must never flash a console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn app_data_dir() -> PathBuf {
    let base = std::env::var("CODEBIUS_APP_DATA_DIR").unwrap_or_else(|_| {
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        format!("{program_data}\\arkode")
    });
    PathBuf::from(base)
}

/// `<install dir>\engine-cli.exe`. The service exe lives at
/// `<install dir>\resources\scheduler\arkode-scheduler.exe`.
/// `ARKODE_ENGINE_CLI` overrides it (used by `--once` testing).
fn engine_cli_path() -> PathBuf {
    if let Ok(p) = std::env::var("ARKODE_ENGINE_CLI") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let fallback = PathBuf::from("engine-cli.exe");
    let Ok(me) = std::env::current_exe() else { return fallback };
    me.parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|install_dir| install_dir.join("engine-cli.exe"))
        .unwrap_or(fallback)
}

fn log_line(msg: &str) {
    let dir = app_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join("scheduler-service.log")) {
        let _ = writeln!(f, "{ts} {msg}");
    }
}

/// Runs one `engine-cli scheduler:tick`, piping its output into the service
/// log. Never panics — a failed tick is logged and the loop continues.
fn run_one_tick() {
    let engine_cli = engine_cli_path();
    let dir = app_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join("scheduler-service.log");

    let stdout = OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let stderr = OpenOptions::new().create(true).append(true).open(&log_path).ok();

    let mut cmd = Command::new(&engine_cli);
    cmd.arg("scheduler:tick");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Some(out) = stdout {
        cmd.stdout(out);
    }
    if let Some(err) = stderr {
        cmd.stderr(err);
    }

    match cmd.status() {
        Ok(status) if status.success() => {}
        Ok(status) => log_line(&format!("scheduler:tick exited with {status}")),
        Err(e) => log_line(&format!("could not run {}: {e}", engine_cli.display())),
    }
}

// ---------- console mode ----------

fn run_once_console() {
    eprintln!("arkode-scheduler --once: running a single tick via {}", engine_cli_path().display());
    run_one_tick();
    eprintln!("done — see {}\\logs\\scheduler-service.log", app_data_dir().display());
}

// ---------- service mode ----------

#[cfg(windows)]
mod service {
    use super::*;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_dispatcher;

    windows_service::define_windows_service!(ffi_service_main, service_main);

    pub fn start() -> windows_service::Result<()> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = run() {
            log_line(&format!("service_main error: {e}"));
        }
    }

    fn run() -> windows_service::Result<()> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let event_handler = move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };

        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

        let running = |controls: ServiceControlAccept| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: controls,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        let simple = |state: ServiceState| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        };

        status_handle.set_service_status(running(ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN))?;
        log_line("service started");

        loop {
            run_one_tick();
            // Sleep TICK_INTERVAL, but wake immediately on a stop request.
            match stop_rx.recv_timeout(TICK_INTERVAL) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            }
        }

        log_line("service stopping");
        status_handle.set_service_status(simple(ServiceState::StopPending))?;
        status_handle.set_service_status(simple(ServiceState::Stopped))?;
        Ok(())
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--once") {
        run_once_console();
        return;
    }

    #[cfg(windows)]
    {
        if let Err(e) = service::start() {
            // Started outside the SCM (e.g. double-clicked) — fall back to a
            // single console tick so the exe is never a silent no-op.
            eprintln!("not running under the Service Control Manager ({e}); doing a single --once tick instead");
            run_once_console();
        }
    }

    #[cfg(not(windows))]
    {
        eprintln!("arkode-scheduler is Windows-only");
        std::process::exit(1);
    }
}
