@echo off
chcp 65001 > nul
title 关闭协同读书服务

powershell -Command "Get-NetTCPConnection -LocalPort 3030 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo ====================================================
echo    ✅ 协同读书服务已成功停止，3030 端口已释放！
echo ====================================================
timeout /t 2 > nul
