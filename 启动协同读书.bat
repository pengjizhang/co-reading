@echo off
chcp 65001 > nul
title 协同读书 (Port 3030)

cd /d "%~dp0"

echo ====================================================
echo            正在更新并启动协同读书...
echo ====================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "$listeners = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue; foreach ($listener in $listeners) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue }; $limit = (Get-Date).AddSeconds(5); while ((Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 100 }; if (Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
    echo 无法替换旧服务，请先运行“关闭协同读书.bat”。
    pause
    exit /b 1
)

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3030'"
"C:\Program Files\nodejs\node.exe" server.js
