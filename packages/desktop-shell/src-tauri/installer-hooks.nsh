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
