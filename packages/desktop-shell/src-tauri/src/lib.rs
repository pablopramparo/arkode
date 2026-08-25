use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the spawned engine-cli sidecar's handle so it can be killed when
/// the app exits — a real install has no dev-time process to fall back on,
/// so an unclean shutdown here would leave an orphaned `engine-cli.exe serve`
/// silently holding the port and the SQLite file.
struct EngineProcess(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
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
        // without the dev-time env vars being set by hand. mysqldump/
        // mariadb-dump are deliberately NOT vendored (GPLv2 — a real,
        // confirmed decision, not an oversight) and so get no equivalent env
        // var here; those stay a manual per-machine install either way.
        let resolve_pg_tool = |name: &str| {
          app
            .path()
            .resolve(format!("resources/pgsql/bin/{name}"), tauri::path::BaseDirectory::Resource)
            .unwrap_or_else(|_| panic!("failed to resolve vendored {name} path"))
            .to_string_lossy()
            .to_string()
        };

        let (_rx, child) = app
          .shell()
          .sidecar("engine-cli")
          .expect("failed to resolve the engine-cli sidecar binary")
          .args(["serve", "--port", "4287"])
          .envs([
            ("PG_DUMP_PATH", resolve_pg_tool("pg_dump.exe")),
            ("PG_RESTORE_PATH", resolve_pg_tool("pg_restore.exe")),
            ("PSQL_PATH", resolve_pg_tool("psql.exe")),
          ])
          .spawn()
          .expect("failed to spawn the engine-cli sidecar");
        *app.state::<EngineProcess>().0.lock().unwrap() = Some(child);
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
