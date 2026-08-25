; Tauri's default NSIS template has no built-in "create a Desktop shortcut"
; option (confirmed against @tauri-apps/cli's own config.schema.json — no
; such toggle exists), but it does expose these hook points for exactly this
; kind of small customization — see CLAUDE.md's "Packaging" section.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\arkode.lnk" "$INSTDIR\app.exe"
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
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM engine-cli.exe'
  nsExec::ExecToLog 'taskkill /F /IM app.exe'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM engine-cli.exe'
  nsExec::ExecToLog 'taskkill /F /IM app.exe'
  Sleep 500
!macroend
