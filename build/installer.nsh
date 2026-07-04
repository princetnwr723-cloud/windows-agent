; Vnus Agent — Windows NSIS Installer Script
; This runs during installation to request permissions

!macro customInit
  ; Check Windows version (need Win 10+)
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  IntCmp $0 17763 win10ok win10ok
    MessageBox MB_OK|MB_ICONEXCLAMATION "Vnus Agent requires Windows 10 or later."
    Abort
  win10ok:
!macroend

!macro customInstall
  ; Add to Windows startup (runs on login)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VnusAgent" "$INSTDIR\Vnus Agent.exe"
  
  ; Add firewall exception
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
