; NSIS uninstall hooks for RTL Radio.
; Tauri's template already checks for a running app; force-close as a fallback so
; rtl-radio.exe is not left locked in Program Files during uninstall.

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM rtl-radio.exe /T'
  Sleep 300
!macroend
