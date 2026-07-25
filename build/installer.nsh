; Agentic Vnus — Windows NSIS Installer Script
; Purana app auto-close hoga, koi manual step nahi

!macro customInit
  ; Pehle check karo app chal raha hai kya
  ; Agar chal raha hai to force kill karo
  nsExec::ExecToLog 'taskkill /F /IM "Vnus Agent.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "VnusAgent.exe" /T'
  ; 2 second wait karo process band hone ke liye
  Sleep 2000
!macroend

!macro customInstall
  ; Startup mein add karo
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AgenticVnus" "$INSTDIR\Vnus Agent.exe"

  ; Firewall rules
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Agentic Vnus" dir=in action=allow program="$INSTDIR\Vnus Agent.exe" enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Agentic Vnus" dir=out action=allow program="$INSTDIR\Vnus Agent.exe" enable=yes'

  ; Ollama ke liye bhi firewall rule
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Ollama" dir=in action=allow program="%LOCALAPPDATA%\Programs\Ollama\ollama.exe" enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Ollama" dir=out action=allow program="%LOCALAPPDATA%\Programs\Ollama\ollama.exe" enable=yes'
!macroend

!macro customUnInstall
  ; App band karo pehle
  nsExec::ExecToLog 'taskkill /F /IM "Vnus Agent.exe" /T'
  Sleep 1000

  ; Startup se remove karo
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AgenticVnus"

  ; Firewall rules remove karo
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Agentic Vnus"'

  ; App data remove karo
  RMDir /r "$APPDATA\agentic-vnus"
  RMDir /r "$LOCALAPPDATA\agentic-vnus"
!macroend