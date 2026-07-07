; Vnus Agent — Windows NSIS Installer Script
; Works on Windows 7, 8, 10, 11 and all versions

!macro customInit
  ; No version check — works on all Windows versions
!macroend

!macro customInstall
  ; Add to Windows startup (runs on login)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VnusAgent" "$INSTDIR\Vnus Agent.exe"

  ; Add firewall exception silently
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Vnus Agent" dir=in action=allow program="$INSTDIR\Vnus Agent.exe" enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Vnus Agent" dir=out action=allow program="$INSTDIR\Vnus Agent.exe" enable=yes'
!macroend

!macro customUnInstall
  ; Remove from startup
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VnusAgent"

  ; Remove firewall rules
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Vnus Agent"'

  ; Remove agent data
  RMDir /r "$APPDATA\vnus-agent"
!macroend
