Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell -Command ""Get-NetTCPConnection -LocalPort 3030 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }""", 0, True
