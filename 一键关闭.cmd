@echo off
chcp 65001 >nul
setlocal

taskkill /IM tt-dsh-desktop.exe /F >nul 2>&1
taskkill /IM tt-desktop-app.exe /F >nul 2>&1
if %errorlevel%==0 (echo [OK] 应用已关闭) else (echo [..] 应用未在运行)

rem 清理内核 / 安装器 node 进程（仅匹配本项目 DSH 内核与 install-kernel 的命令行，不碰其他 node）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dsh.+bin\.js|install-kernel\.cjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('[OK] 已结束内核进程 PID ' + $_.ProcessId) }"

ping -n 3 127.0.0.1 >nul
