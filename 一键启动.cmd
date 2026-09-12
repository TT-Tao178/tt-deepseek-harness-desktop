@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "EXE=src-tauri\target\release\tt-dsh-desktop.exe"
if not exist "%EXE%" set "EXE=src-tauri\target\release\tt-desktop-app.exe"
if not exist "%EXE%" set "EXE=src-tauri\target\debug\tt-dsh-desktop.exe"
if not exist "%EXE%" set "EXE=src-tauri\target\debug\tt-desktop-app.exe"
if not exist "%EXE%" (
    echo [X] 未找到 tt-dsh-desktop.exe（或旧名 tt-desktop-app.exe），请先构建：
    echo     cargo build --manifest-path src-tauri/Cargo.toml --release
    pause
    exit /b 1
)

start "" "%EXE%"
echo [OK] 已启动（应用自带单实例：已在运行时会自动聚焦已有窗口）
ping -n 3 127.0.0.1 >nul
