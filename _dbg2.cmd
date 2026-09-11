@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dsh.lib\.bin\.js|install-kernel\.cjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('[OK] 已结束内核进程 PID ' + $_.ProcessId) }"
