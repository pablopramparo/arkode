; Tauri's default NSIS template has no built-in "create a Desktop shortcut"
; option (confirmed against @tauri-apps/cli's own config.schema.json — no
; such toggle exists), but it does expose these hook points for exactly this
; kind of small customization — see CLAUDE.md's "Packaging" section.
;
; POSTINSTALL also installs and starts the `arkode-scheduler` Windows service
; (src/bin/scheduler.rs, vendored at resources\scheduler\arkode-scheduler.exe)
; — the unattended scheduler as of v0.3.0. The installer already runs elevated
; (perMachine), so `sc` here needs no extra prompt; this is what replaces the
; per-task "Registrar en Windows" UAC flow entirely. `scheduler:cleanup-legacy`
; tears down any pre-v0.3.0 per-task Scheduled Tasks on the same pass.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\arkode.lnk" "$INSTDIR\app.exe"

  ; Recreate the service from scratch every install/update so binPath is
  ; always current (PREINSTALL already stopped+deleted any prior copy).
  nsExec::ExecToLog 'sc create arkode-scheduler binPath= "$INSTDIR\resources\scheduler\arkode-scheduler.exe" start= auto obj= LocalSystem DisplayName= "arkode backup scheduler"'
  nsExec::ExecToLog 'sc description arkode-scheduler "Ejecuta los backups de base de datos y de archivos programados en arkode."'
  nsExec::ExecToLog 'sc failure arkode-scheduler reset= 86400 actions= restart/60000/restart/60000/restart/300000'
  nsExec::ExecToLog '"$INSTDIR\engine-cli.exe" scheduler:cleanup-legacy'
  nsExec::ExecToLog 'sc start arkode-scheduler'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\arkode.lnk"
!macroend

; Backstop for a real failure hit while reinstalling on 2026-08-25: the
; engine-cli.exe sidecar is normally killed by app.exe's own
; RunEvent::ExitRequested handler when the app closes gracefully, but an
; orphaned sidecar (left running if that graceful path doesn't fire — e.g. a
; forceful process kill instead of a normal window close) held its own exe
; file locked and made file-copy fail outright, mid-install, with a
; retry/abort/skip dialog. That dialog only appears in an *interactive*
; install; the real auto-updater always runs silently (/S), where the same
; lock would fail with no dialog for the user to react to. Force-killing both
; by name before any files are touched removes the dependency on that
; graceful shutdown path entirely — safe even when neither process is
; running, since taskkill's "not found" exit code is simply ignored here.
;
; `sc stop` + `sc delete` for the scheduler service comes first for the same
; reason — a running service holds arkode-scheduler.exe (and, mid-tick,
; engine-cli.exe) locked. `sc stop` is synchronous enough here; a stray
; in-progress backup it kills is marked Failed by the next tick's stale-run
; recovery (isStaleInProgressRun) after the service restarts.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'sc stop arkode-scheduler'
  nsExec::ExecToLog 'sc delete arkode-scheduler'
  Sleep 500
  nsExec::ExecToLog 'taskkill /F /IM engine-cli.exe'
  nsExec::ExecToLog 'taskkill /F /IM app.exe'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'sc stop arkode-scheduler'
  nsExec::ExecToLog 'sc delete arkode-scheduler'
  Sleep 500
  nsExec::ExecToLog 'taskkill /F /IM engine-cli.exe'
  nsExec::ExecToLog 'taskkill /F /IM app.exe'
  Sleep 500
!macroend
