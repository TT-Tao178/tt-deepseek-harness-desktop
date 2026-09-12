; TT DeepSeek Harness Desktop 安装器钩子（官方 installerHooks 机制）
;
; PREUNINSTALL：先摘除 dsh-home 内的插件 junction。
; dsh-home/node_modules/<id> 是指向（可能的）用户自定义安装目录的 junction，
; 若卸载器的递归删除跟随 junction 会误删源目录 —— 用 cmd rmdir 先摘链
; （cmd rmdir 对 junction 只删链接本身，不动目标）。
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'cmd /C rmdir /s /q "$APPDATA\com.tt.deepharness\dsh-home\node_modules"'
!macroend

; POSTINSTALL：清理旧版主程序名（0.4.2 起 tt-desktop-app.exe 更名为
; tt-dsh-desktop.exe；覆盖安装时旧文件不在卸载清单里，手动清掉防混淆）。
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\tt-desktop-app.exe"
!macroend

; POSTUNINSTALL：清掉运行期产生的目录（内核更新 staging 与备份）
!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\kernel-staging"
  RMDir /r "$INSTDIR\kernel-backup"
!macroend
