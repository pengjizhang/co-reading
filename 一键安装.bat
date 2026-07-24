@echo off
chcp 65001 > nul
title 安装协同读书依赖
cd /d "%~dp0"

echo.
echo ====================================================
echo       同读 · 一键安装 (Co-reading Setup)
echo ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址：https://nodejs.org （推荐 20 LTS 版本）
    echo.
    pause
    exit /b 1
)

echo [1/4] Node.js 已就绪
node -v
echo.

echo [2/4] 安装后端依赖...
call npm install
if errorlevel 1 (
    echo [错误] 后端依赖安装失败
    pause
    exit /b 1
)
echo [2/4] 后端依赖安装完成
echo.

echo [3/4] 安装前端依赖并构建...
cd client
call npm install
if errorlevel 1 (
    echo [错误] 前端依赖安装失败
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo [错误] 前端构建失败
    pause
    exit /b 1
)
cd ..
echo [3/4] 前端构建完成
echo.

echo [4/4] 安装完成！
echo.
echo ====================================================
echo   安装成功！现在可以双击 "启动协同读书.bat" 开始阅读
echo   浏览器访问 http://localhost:3030
echo ====================================================
echo.
pause
