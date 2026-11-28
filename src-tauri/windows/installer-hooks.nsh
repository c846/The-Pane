; Extra steps for the NSIS installer (see bundle.windows.nsis in tauri.conf.json).
;
; The Pane is the current user's shell: Windows starts it at sign-in instead
; of Explorer (the per-user "Shell" value under Winlogon). Uninstalling
; removes that value, so the next sign-in falls back to Explorer.
;
; Before installing over it or uninstalling it, the running copy is asked to
; quit ("--quit") so its files aren't in use.

!define PANE_WINLOGON_KEY "Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
; Where versions before 0.2 started from (alongside Explorer).
!define PANE_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +2
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${PANE_WINLOGON_KEY}" "Shell" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  DeleteRegValue HKCU "${PANE_RUN_KEY}" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +2
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "${PANE_WINLOGON_KEY}" "Shell"
  DeleteRegValue HKCU "${PANE_RUN_KEY}" "${PRODUCTNAME}"
!macroend
