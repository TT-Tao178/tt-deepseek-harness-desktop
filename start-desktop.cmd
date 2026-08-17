@echo off
rem TT DeepSeek Harness Desktop — 带日志控制台的启动方式
rem 关闭本窗口 = 结束应用（含内核子进程）；想看日志用这个，不想要黑框用 start-desktop.vbs
cd /d "%~dp0"
if not exist dist\main.js (
  echo [build] 首次构建，请稍候...
  call pnpm build
  if errorlevel 1 ( echo [error] 构建失败 & pause & exit /b 1 )
)
echo [start] 启动应用，关闭本窗口将结束应用...
call pnpm start
