use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Tauri's `path().resolve(.., Resource)` returns a Windows extended-length
/// ("verbatim") path, `\\?\C:\...`. That works for the OS, but it leaks into
/// child processes' argv[0] and shows up verbatim in e.g. a `--version`
/// banner surfaced in the UI. Strip the prefix for a clean path -- the
/// non-verbatim form is equivalent for every path this app resolves (all
/// short, all local).
fn clean_resource_path(p: std::path::PathBuf) -> String {
  let s = p.to_string_lossy().to_string();
  s.strip_prefix(r"\\?\UNC\")
    .map(|rest| format!(r"\\{rest}"))
    .or_else(|| s.strip_prefix(r"\\?\").map(str::to_string))
    .unwrap_or(s)
}

/// Mirrors engine-core's paths.ts logsDir() (CODEBIUS_APP_DATA_DIR override,
/// else %PROGRAMDATA%\arkode\logs) without depending on any TypeScript code
/// -- this is Rust-side only, used solely to find where to append the
/// sidecar's own stdout/stderr.
fn logs_dir() -> std::path::PathBuf {
  let app_data_dir = std::env::var("CODEBIUS_APP_DATA_DIR").unwrap_or_else(|_| {
    let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    format!("{program_data}\\arkode")
  });
  std::path::PathBuf::from(app_data_dir).join("logs")
}

/// Holds the spawned engine-cli sidecar's handle so it can be killed when
/// the app exits — a real install has no dev-time process to fall back on,
/// so an unclean shutdown here would leave an orphaned `engine-cli.exe serve`
/// silently holding the port and the SQLite file.
struct EngineProcess(Mutex<Option<CommandChild>>);

/// The backend's actual bound port, as the frontend's fetch clients need to
/// know it — not always 4287, since engine-cli's `serve` command falls back
/// to an OS-assigned free port if 4287 is already taken on this machine
/// (see the PORT= line parsing below). A watch channel, not a plain Mutex,
/// because get_api_port (below) needs to be able to *wait* for the value:
/// the frontend calls it essentially immediately on startup, likely before
/// the sidecar has even printed its port yet.
struct ApiPort(tokio::sync::watch::Sender<Option<u16>>);

/// Resolves the local backend's actual port. In dev (`tauri dev`), nothing
/// here ever spawns a sidecar -- the documented dev workflow starts
/// `engine-cli serve --port 4287` by hand in a separate terminal (see
/// CLAUDE.md's "UI" section) -- so ApiPort is pre-seeded with the
/// conventional 4287 and this returns immediately. In production, the real
/// spawned sidecar may have fallen back to a different port, so this waits
/// (bounded) for that port to actually be known.
#[tauri::command]
async fn get_api_port(state: tauri::State<'_, ApiPort>) -> Result<u16, String> {
  let mut rx = state.0.subscribe();
  if let Some(port) = *rx.borrow() {
    return Ok(port);
  }
  tokio::time::timeout(std::time::Duration::from_secs(15), async {
    loop {
      if rx.changed().await.is_err() {
        return Err("the backend's port channel closed before a port was reported".to_string());
      }
      if let Some(port) = *rx.borrow() {
        return Ok(port);
      }
    }
  })
  .await
  .map_err(|_| "timed out waiting for the backend to report its port -- it may have failed to start (check sidecar.log)".to_string())?
}

/// Registers a task's Windows Scheduled Task by shelling out to the
/// installed engine-cli.exe's own `scheduler:install` -- elevated, via a
/// single UAC prompt (ShellExecuteW "runas" under the hood, wrapped by the
/// `runas` crate), rather than requiring this whole app to run elevated at
/// all times. Mirrors the exact manual flow already verified by hand
/// (Start-Process -Verb RunAs) -- the underlying scheduling logic stays in
/// engine-core/engine-cli, this command only ever triggers the privileged
/// process, never touches Task Scheduler or the database directly itself.
///
/// `task_id` reaches the child process as a separate argv element (never
/// concatenated into a shell string), so there's no injection surface
/// regardless of its content -- it's expected to be a UUID from the
/// database either way.
///
/// Dev-mode (`tauri dev`) has no installed engine-cli.exe sibling to shell
/// out to -- current_exe() there points into a cargo target directory, not
/// a real install -- so this is production-only, matching every other
/// production-only branch in this file (the sidecar spawn above).
#[tauri::command]
async fn register_task_schedule(task_id: String) -> Result<(), String> {
  if cfg!(debug_assertions) {
    return Err(
      "No disponible en modo desarrollo -- corré esto desde una terminal elevada: engine-cli scheduler:install <taskId>".to_string(),
    );
  }

  let exe_dir = std::env::current_exe()
    .map_err(|e| format!("No se pudo resolver la ruta de la app: {e}"))?
    .parent()
    .map(|p| p.to_path_buf())
    .ok_or_else(|| "No se pudo resolver la carpeta de instalación.".to_string())?;
  let engine_cli = exe_dir.join("engine-cli.exe");

  let status = tauri::async_runtime::spawn_blocking(move || {
    runas::Command::new(&engine_cli)
      .arg("scheduler:install")
      .arg(&task_id)
      .status()
  })
  .await
  .map_err(|e| format!("Error interno esperando el proceso elevado: {e}"))?
  .map_err(|e| format!("No se pudo iniciar engine-cli.exe elevado (¿cancelaste el aviso de administrador de Windows?): {e}"))?;

  if status.success() {
    Ok(())
  } else {
    Err(format!(
      "engine-cli.exe scheduler:install terminó con un error (código {:?}) -- revisá que la tarea exista y tenga un horario configurado.",
      status.code()
    ))
  }
}

/// The removal-side mirror of register_task_schedule — deactivating a task
/// in arkode never touches Task Scheduler on its own (it's a plain DB
/// update, no elevation needed), so a task that *was* registered stays
/// registered after being deactivated. isTaskDue() already checks
/// is_active, so a stale registration can never actually run anything —
/// this exists purely so Task Scheduler doesn't accumulate dead entries,
/// not because leaving one behind is unsafe. Same one-UAC-prompt-per-action
/// shape as register_task_schedule; see that command's own doc comment for
/// the full reasoning (dev-mode gate, argv-safety, why elevation is scoped
/// to just this one call instead of the whole app).
#[tauri::command]
async fn unregister_task_schedule(task_id: String) -> Result<(), String> {
  if cfg!(debug_assertions) {
    return Err(
      "No disponible en modo desarrollo -- corré esto desde una terminal elevada: engine-cli scheduler:uninstall <taskId>".to_string(),
    );
  }

  let exe_dir = std::env::current_exe()
    .map_err(|e| format!("No se pudo resolver la ruta de la app: {e}"))?
    .parent()
    .map(|p| p.to_path_buf())
    .ok_or_else(|| "No se pudo resolver la carpeta de instalación.".to_string())?;
  let engine_cli = exe_dir.join("engine-cli.exe");

  let status = tauri::async_runtime::spawn_blocking(move || {
    runas::Command::new(&engine_cli)
      .arg("scheduler:uninstall")
      .arg(&task_id)
      .status()
  })
  .await
  .map_err(|e| format!("Error interno esperando el proceso elevado: {e}"))?
  .map_err(|e| format!("No se pudo iniciar engine-cli.exe elevado (¿cancelaste el aviso de administrador de Windows?): {e}"))?;

  if status.success() {
    Ok(())
  } else {
    Err(format!(
      "engine-cli.exe scheduler:uninstall terminó con un error (código {:?}).",
      status.code()
    ))
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Debug (`tauri dev`) never spawns its own sidecar (see the setup() branch
  // below), so there's no PORT= line to ever parse there -- pre-seed the
  // conventional 4287 so get_api_port resolves immediately instead of
  // waiting 15s for a port that dev mode was never going to report.
  let (api_port_tx, _api_port_rx) = tokio::sync::watch::channel(if cfg!(debug_assertions) { Some(4287) } else { None });

  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![get_api_port, register_task_schedule, unregister_task_schedule])
    // Must be the first plugin registered — it needs to intercept the app
    // launch before anything else runs. A second launch attempt is
    // redirected here instead of opening a second window: focus the
    // existing one instead of leaving the user staring at a launch that
    // silently did nothing.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
    // Off by default (see the plugin's own default state) — this only
    // changes Windows' startup behavior when the user explicitly opts in
    // via the toggle in Configuración; nothing here enables it silently.
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(EngineProcess(Mutex::new(None)))
    .manage(ApiPort(api_port_tx))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      } else {
        // Production only: the documented dev workflow (see CLAUDE.md's "UI"
        // section) starts `engine-cli serve` by hand against the same port —
        // spawning our own copy here too would just fight it for the port.
        // A real install has no such process, so the app owns starting (and,
        // on exit below, stopping) its own backend.
        //
        // PG_DUMP_PATH/PG_RESTORE_PATH/PSQL_PATH point at the Postgres client
        // tools vendored under resources/pgsql/bin/ (see prepare-pg-tools.mjs
        // and CLAUDE.md's "Packaging" section) — engine-core already reads
        // these exact env vars as its default tool paths, so no engine-core
        // code needed to change for a real install to have them "just work"
        // without the dev-time env vars being set by hand. The MariaDB
        // dumper + client (resources/mariadb/, prepare-mariadb-tools.mjs) get
        // the same treatment below via MARIADB_DUMP_PATH/MYSQL_CLI_PATH;
        // Oracle's own mysqldump/mysql stay unbundled (arkode ships one
        // family).
        let resolve_pg_tool = |name: &str| {
          app
            .path()
            .resolve(format!("resources/pgsql/bin/{name}"), tauri::path::BaseDirectory::Resource)
            .map(clean_resource_path)
            .unwrap_or_else(|_| panic!("failed to resolve vendored {name} path"))
        };

        // Vendored by prepare-restic.mjs (see that script + CLAUDE.md's
        // file-backup "Packaging" notes) — restic.exe is BSD-2-Clause, a
        // single static binary, so this needs no per-file exclusion list
        // the way pgsql's DLL vendoring does. engine-core already reads
        // RESTIC_PATH as its default restic binary location (see
        // fileBackup/restic/resticClient.ts), so no engine-core code needed
        // to change for this to "just work."
        let resolve_restic_tool = |name: &str| {
          app
            .path()
            .resolve(format!("resources/restic/{name}"), tauri::path::BaseDirectory::Resource)
            .map(clean_resource_path)
            .unwrap_or_else(|_| panic!("failed to resolve vendored {name} path"))
        };

        // MariaDB's dumper + client, GPLv2 (see LICENSES/NOTICE.md). Bundled
        // as the zero-config tooling for BOTH direct_dump engines: a `mysql`
        // task falls back to mariadb-dump when no real mysqldump is
        // configured (see directDumpExecutor.ts), and the connection tester
        // uses mariadb.exe when MYSQL_CLI_PATH is unset. engine-core's
        // toolPaths.ts already resolves these relative to engine-cli.exe, so
        // these env vars are belt-and-suspenders / explicitness, matching
        // the pg + restic entries.
        let resolve_mariadb_tool = |name: &str| {
          app
            .path()
            .resolve(format!("resources/mariadb/{name}"), tauri::path::BaseDirectory::Resource)
            .map(clean_resource_path)
            .unwrap_or_else(|_| panic!("failed to resolve vendored {name} path"))
        };

        let (mut rx, child) = app
          .shell()
          .sidecar("engine-cli")
          .expect("failed to resolve the engine-cli sidecar binary")
          .args(["serve", "--port", "4287"])
          .envs([
            ("PG_DUMP_PATH", resolve_pg_tool("pg_dump.exe")),
            ("PG_RESTORE_PATH", resolve_pg_tool("pg_restore.exe")),
            ("PSQL_PATH", resolve_pg_tool("psql.exe")),
            ("RESTIC_PATH", resolve_restic_tool("restic.exe")),
            ("MARIADB_DUMP_PATH", resolve_mariadb_tool("mariadb-dump.exe")),
            ("MYSQL_CLI_PATH", resolve_mariadb_tool("mariadb.exe")),
          ])
          .spawn()
          .expect("failed to spawn the engine-cli sidecar");
        *app.state::<EngineProcess>().0.lock().unwrap() = Some(child);

        // Without this, the sidecar's own stdout/stderr (e.g. the "Port 4287
        // is already in use" message engine-cli's `serve` command now logs
        // instead of crashing unhandled) went nowhere in a real install --
        // there's no visible terminal here like there is in the dev
        // workflow, so a startup failure was completely silent with no
        // diagnostic trail anywhere, not even a log file. Appended to
        // sidecar.log under the same app-data logs directory the rest of
        // the app already uses, so there's one place to check. This same
        // stream is also how the app learns the sidecar's *actual* port
        // (see engine-cli's `serve` -- it falls back off 4287 on a
        // conflict and prints `PORT=<n>` on its own line either way).
        let api_port_tx = app.state::<ApiPort>().0.clone();
        tauri::async_runtime::spawn(async move {
          let log_path = logs_dir().join("sidecar.log");
          if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
          }
          while let Some(event) = rx.recv().await {
            let line = match event {
              CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                if let Some(port_str) = text.trim().strip_prefix("PORT=") {
                  if let Ok(port) = port_str.parse::<u16>() {
                    let _ = api_port_tx.send(Some(port));
                  }
                }
                Some(format!("[stdout] {text}"))
              }
              CommandEvent::Stderr(bytes) => Some(format!("[stderr] {}", String::from_utf8_lossy(&bytes))),
              CommandEvent::Error(err) => Some(format!("[error] {err}")),
              CommandEvent::Terminated(payload) => Some(format!("[terminated] code={:?} signal={:?}", payload.code, payload.signal)),
              _ => None,
            };
            if let Some(line) = line {
              if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
                let _ = writeln!(file, "{}", line.trim_end());
              }
            }
          }
        });
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let RunEvent::ExitRequested { .. } = event {
        if let Some(child) = app_handle.state::<EngineProcess>().0.lock().unwrap().take() {
          let _ = child.kill();
        }
      }
    });
}
