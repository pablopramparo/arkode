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

; --------------------------------------------------------------------------
; Waits (up to ~15 s) for a process's image lock to actually be released
; after a taskkill. The Tauri silent auto-updater overwrites app.exe /
; engine-cli.exe in place; if one is still locked when NSIS tries to write
; it, that single file is left un-replaced and the install ends up partial
; with no dialog (this exact breakage was hit 2026-08-29 — app.exe missing,
; no registry entry). A just-killed process's .exe stays briefly locked by
; Windows, so a fixed `Sleep` isn't enough — poll until it's really gone.
; TAG must be a label-safe token (no dots).
; --------------------------------------------------------------------------
!macro WAIT_PROCESS_GONE PROC TAG
  Push $R0
  Push $R1
  StrCpy $R0 0
  wait_loop_${TAG}:
    ; findstr's exit code becomes cmd's: "0" = the process line was found
    ; (still running), anything else = gone.
    nsExec::Exec 'cmd /c tasklist /NH /FI "IMAGENAME eq ${PROC}" | findstr /I /C:"${PROC}"'
    Pop $R1
    StrCmp $R1 "0" 0 wait_done_${TAG}
    IntOp $R0 $R0 + 1
    IntCmp $R0 30 wait_done_${TAG}
    Sleep 500
    Goto wait_loop_${TAG}
  wait_done_${TAG}:
  Pop $R1
  Pop $R0
!macroend

; CTX is a label-safe token unique per !insertmacro site (NSIS labels are
; global, so inserting this in both PREINSTALL and PREUNINSTALL would
; otherwise redefine the same labels).
!macro STOP_ARKODE_PROCESSES CTX
  nsExec::ExecToLog 'sc stop arkode-scheduler'
  nsExec::ExecToLog 'sc delete arkode-scheduler'
  nsExec::ExecToLog 'taskkill /F /IM app.exe'
  nsExec::ExecToLog 'taskkill /F /IM engine-cli.exe'
  nsExec::ExecToLog 'taskkill /F /IM arkode-scheduler.exe'
  !insertmacro WAIT_PROCESS_GONE "app.exe" "app_${CTX}"
  !insertmacro WAIT_PROCESS_GONE "engine-cli.exe" "enginecli_${CTX}"
  !insertmacro WAIT_PROCESS_GONE "arkode-scheduler.exe" "svc_${CTX}"
!macroend

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

; Stop everything and *wait for the locks to clear* before any file is
; touched — removes the "app.exe was locked, update left a hole" failure
; mode. Safe even when nothing is running (taskkill/sc "not found" are
; ignored). A stray in-progress backup killed here is marked Failed by the
; next tick's stale-run recovery (isStaleInProgressRun) after restart.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro STOP_ARKODE_PROCESSES PRE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro STOP_ARKODE_PROCESSES PREUN
!macroend
