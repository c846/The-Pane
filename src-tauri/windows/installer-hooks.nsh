; Extra steps for the NSIS installer (see bundle.windows.nsis in tauri.conf.json).
;
; The Pane hides the taskbar while it runs, so it must never be killed
; outright: before installing over it or uninstalling it, ask it to quit
; ("--quit"), which puts the taskbar back first.
; It starts with Windows through the current user's Run key.

!define PANE_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +2
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${PANE_RUN_KEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +2
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "${PANE_RUN_KEY}" "${PRODUCTNAME}"
!macroend
