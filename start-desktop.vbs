' TT DeepSeek Harness Desktop — 双击启动（无黑色命令框）
' 首次运行或源码变更后，自动先执行 pnpm build，再启动应用。
' 如需查看内核/终端日志，改用 start-desktop.cmd。

Option Explicit
Dim ws, fso, appDir, distMain
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 脚本所在目录即项目根
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = appDir

distMain = appDir & "\dist\main.js"
If Not fso.FileExists(distMain) Then
    ' 隐藏窗口执行构建（首次 / dist 被清空时）
    ws.Run "cmd /c pnpm build", 0, True
    If Not fso.FileExists(distMain) Then
        MsgBox "构建失败：dist\main.js 不存在。" & vbCrLf & "请用 start-desktop.cmd 查看详细错误。", vbExclamation, "TT DeepSeek Harness Desktop"
        WScript.Quit 1
    End If
End If

' 隐藏窗口启动应用（electron 主窗口正常显示；0 = 隐藏控制台）
ws.Run "cmd /c pnpm start", 0, False
