If WScript.Arguments.Named.Exists("check") Then
    WScript.Echo "STARTUP_SCRIPT_OK"
    WScript.Quit 0
End If

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = scriptDir & "\.logs"

If Not fso.FolderExists(logDir) Then
    fso.CreateFolder(logDir)
End If

stdoutLog = logDir & "\server.stdout.log"
stderrLog = logDir & "\server.stderr.log"
pidFile = logDir & "\server.pid"
nodeExe = "C:\Program Files\nodejs\node.exe"

If Not fso.FileExists(nodeExe) Then
    MsgBox "Node.js was not found: " & nodeExe, 16, "Co-reading startup failed"
    WScript.Quit 1
End If

escapedDir = Replace(scriptDir, "'", "''")
escapedStdout = Replace(stdoutLog, "'", "''")
escapedStderr = Replace(stderrLog, "'", "''")
escapedPid = Replace(pidFile, "'", "''")

stopCommand = "powershell -NoProfile -ExecutionPolicy Bypass -Command ""$items=Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue; foreach($item in $items){Stop-Process -Id $item.OwningProcess -Force -ErrorAction SilentlyContinue}; Start-Sleep -Milliseconds 300"""
WshShell.Run stopCommand, 0, True

startCommand = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""$p=Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory '" & escapedDir & "' -WindowStyle Hidden -RedirectStandardOutput '" & escapedStdout & "' -RedirectStandardError '" & escapedStderr & "' -PassThru; Set-Content -LiteralPath '" & escapedPid & "' -Value $p.Id"""
startCode = WshShell.Run(startCommand, 0, True)

If startCode <> 0 Then
    MsgBox "Node failed to start. See: " & vbCrLf & stderrLog, 16, "Co-reading startup failed"
    WScript.Quit startCode
End If

ready = False
For attempt = 1 To 30
    On Error Resume Next
    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", "http://127.0.0.1:3030/api/health", False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
        If InStr(http.ResponseText, """version"":12") > 0 Then
            ready = True
        End If
    End If
    Err.Clear
    On Error GoTo 0
    If ready Then Exit For
    WScript.Sleep 250
Next

If ready Then
    WshShell.Run "http://localhost:3030"
Else
    MsgBox "Service did not start as v12. See: " & vbCrLf & stderrLog, 16, "Co-reading startup failed"
    WScript.Quit 1
End If
