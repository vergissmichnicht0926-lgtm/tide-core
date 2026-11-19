' Hidden launcher for TideGatewayProbe.
' Task Scheduler runs wscript with no console window; powershell is
' started with window style 0 so nothing flashes on the desktop.
' Path is resolved relative to this file, so the repo can live anywhere.
Dim sh, cmd, rc, fso, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\probe-gateway.ps1"
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """"
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
