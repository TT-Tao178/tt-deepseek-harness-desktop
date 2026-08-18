# TT DeepSeek Harness Desktop

> **非官方项目**：基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的 Windows 桌面封装，与 DeepSeek 官方无隶属关系。

把 DeepSeek Harness 的 AI 编程助手界面装进原生 Windows 窗口：托盘常驻、内核自愈、关闭行为可选、主题联动。

![Electron](https://img.shields.io/badge/Electron-33-47848F) ![Node](https://img.shields.io/badge/Bundled%20Node-22.21.0-339933) ![DSH](https://img.shields.io/badge/dsh-0.1.0--rc.6-4D7CFE) ![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)

---

## 目录

- [这是什么](#这是什么)
- [安装](#安装)
  - [方式一：安装包安装（推荐）](#方式一安装包安装推荐)
  - [方式二：从源码运行](#方式二从源码运行)
- [使用步骤（第一次打开后）](#使用步骤第一次打开后)
- [关闭窗口行为（托盘 or 退出）](#关闭窗口行为托盘-or-退出)
- [主题](#主题)
- [数据与安全](#数据与安全)
- [常见问题（FAQ）](#常见问题faq)
- [开发相关](#开发相关)
- [声明](#声明)

---

## 这是什么

一个 Windows 桌面应用：启动后弹出正常窗口（不是浏览器），窗口里是 **DeepSeek Harness** 的完整 AI 工作台（对话、工具调用、任务队列、工作流）。

在 dsh 基础上，这个壳额外提供：

- **系统托盘常驻**：关窗不退出，托盘右键可显示/退出；
- **关闭行为可选**：关闭窗口时「最小化到托盘 / 直接退出 / 每次询问」三选一（见下文）；
- **内核自愈**：内部 AI 内核意外崩溃自动重启（1s/4s/16s 退避，最多 3 次），窗口自动恢复；
- **数据隔离**：应用数据全部在自己目录里，不触碰 dsh 命令行的数据；
- **主题联动**：亮 / 暗 / 跟随系统，直接驱动界面。

---

## 安装

### 方式一：安装包安装（推荐）

**1. 获取安装包**：

```text
out\TT DeepSeek Harness Desktop Setup 0.1.0.exe   （约 145MB，位于项目 out 目录或发布附件）
```

**2. 双击安装**（向导式）：

```text
① 欢迎页 → 下一步
② 选择安装目录 → 可点「浏览」自定义位置（默认安装到当前用户目录，无需管理员权限）
③ 选择是否创建桌面快捷方式 → 下一步
④ 安装 → 完成
```

**3. 启动**：双击桌面快捷方式，或从开始菜单打开「TT DeepSeek Harness Desktop」。

**4. 卸载**：设置 → 应用 → 找到「TT DeepSeek Harness Desktop」→ 卸载（卸载后如需清除全部数据，见[数据与安全](#数据与安全)）。

> 提示：安装包目前**未签名**，Windows SmartScreen 可能提示“未知发布者”——点「更多信息 → 仍要运行」即可（仅首次）。

### 方式二：从源码运行

适合开发者/想改代码的人。需要先装好：

| 软件 | 安装方式 | 用途 |
|---|---|---|
| VSCode | code.visualstudio.com 下载安装 | 看代码、一键运行 |
| Node.js 22 LTS | nodejs.org 下载安装 | 构建引擎 |
| pnpm 9 | 装完 Node 后 PowerShell 执行 `npm i -g pnpm@9` | 包管理 |
| Git（可选） | git-scm.com | 版本存档 |

然后按下面任一种方式运行：

```text
方式 ②-a：VSCode 按钮（推荐开发用）
  1. VSCode 打开项目文件夹 D:\Workspace-1\tt-deepseek-harness-desktop
  2. 按 Ctrl+Shift+B（自动编译并启动应用窗口）
  3. 停止：点下方「终端」面板的垃圾桶按钮

方式 ②-b：双击启动器（不想开 VSCode 时）
  双击 start-desktop.vbs   （无黑色命令框）
  或 双击 start-desktop.cmd（带日志控制台，关闭窗口=退出应用）

方式 ②-c：终端命令
  pnpm install   # 首次必做（装依赖，约 10-15 分钟）
  pnpm dev       # 编译 + 启动
  Ctrl+C 停止
```

---

## 使用步骤（第一次打开后）

### 第 1 步：启动

启动后窗口自动加载界面，等待几秒出现工作台（内部内核首次启动约 10-30 秒）。

### 第 2 步：配置 AI 服务（Provider）

要在窗口里对话，需要一个可用的模型服务。两种配置途径（任选）：

```text
途径 A（推荐，有图形界面）：在窗口内的「模型设置」页配置
  1. 打开窗口左下角/侧边栏的「设置 → Models」
  2. 添加 Provider：
     - DeepSeek 官方：填 API Key 即可（官方地址自动识别）
     - 本地服务（Ollama / LM Studio / llama.cpp / vLLM）：填 baseURL
       例：http://127.0.0.1:11434/v1（Ollama）
  3. 保存后即可在对话输入框上方的模型选择器里选中模型

途径 B（程序化接口，密钥走系统加密）：
  通过 window.dshDesktop.provider.save(...) 调用
  （详见 scripts/verify-provider-theme.cjs 的完整示例）
```

> 说明：你的 API Key 属于你，程序不内置任何密钥。路径 A 的密钥由 dsh 存管；路径 B 的密钥经 Windows 系统加密（safeStorage）落盘，磁盘上只有密文。

### 第 3 步：开始对话

在输入框输入内容回车即可。支持的任务类型取决于 dsh 内核能力（对话、写代码、跑命令、子代理等）。

### 第 4 步：日常开关

- **关闭窗口**：行为由你的设置决定（见下一节）；
- **找回窗口**：双击托盘图标，或托盘右键 → 显示主窗口；
- **彻底退出**：托盘右键 → 退出；
- **内核坏了**：不用管，会自动重启并恢复（最多自动尝试 3 次）。

---

## 关闭窗口行为（托盘 or 退出）

点窗口右上角关闭按钮时，可选三种行为（默认：**每次询问**）：

| 行为 | 效果 |
|---|---|
| 每次询问 | 弹窗问「最小化到托盘 / 退出」，可勾选“记住我的选择，下次不再询问” |
| 最小化到托盘 | 窗口隐藏、程序继续在托盘运行 |
| 直接退出 | 立即退出整个应用（含内核） |

**在哪里改**：托盘图标 → 右键 → 「关闭窗口行为」子菜单 → 单选切换（改完立即生效）。

设置保存在：`%APPDATA%\tt-deepseek-harness-desktop\config\app-settings.json`（删掉该文件即恢复默认）。

---

## 主题

- 界面跟随系统亮暗，也可固定亮/暗：在托盘菜单或界面设置里切换；
- 主题设置写入 dsh 的 `settings.yaml`（`ui-theme.preference`），切换即时生效，不丢失当前会话。

---

## 数据与安全

### 数据都在哪

| 内容 | 位置 |
|---|---|
| 应用设置（关闭行为等） | `%APPDATA%\tt-deepseek-harness-desktop\config\app-settings.json` |
| Provider 配置（不含密钥） | `%APPDATA%\tt-deepseek-harness-desktop\config\providers.json` |
| 加密的 API Key（safeStorage） | `%APPDATA%\tt-deepseek-harness-desktop\secrets\*.enc` |
| 内核日志（排错入口） | `%APPDATA%\tt-deepseek-harness-desktop\logs\kernel.log` |
| dsh 数据（会话/设置/模型配置） | `%APPDATA%\tt-deepseek-harness-desktop\dsh-home` |

### 安全说明

- **不碰系统 `~/.dsh`**：与 DeepSeek Harness 命令行的数据完全隔离；
- **密钥无明文**：API Key 落盘前经 Windows 系统加密（safeStorage）；日志自动脱敏（Bearer/`sk-` 等遮蔽）；
- **进程干净**：退出时内核及其工具子进程整树回收，无残留。

### 彻底卸载数据

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\tt-deepseek-harness-desktop"
```

---

## 常见问题（FAQ）

| 问题 | 解答 |
|---|---|
| 窗口空白 / 内核起不来 | 查看 `%APPDATA%\tt-deepseek-harness-desktop\logs\kernel.log` 最后几行；重启应用 |
| 安装包提示未知发布者 | 未签名所致，点「更多信息 → 仍要运行」；正式发布建议配置代码签名 |
| 关闭窗口后程序不见了 | 它在托盘（右下角小箭头里）；双击托盘图标可唤回 |
| 想彻底退出却退不掉 | 托盘右键 → 退出（或在「关闭窗口行为」里选「直接退出」） |
| 内存占用偏高 | Electron+内核方案固有代价（稳定态约 330-600MB）；属正常 |
| 改了代码没生效 | 先编译：Ctrl+Shift+B 或 `pnpm build` |
| 对话提示没有模型 | 回到「使用步骤 → 第 2 步」配置 Provider |

---

## 开发相关

```powershell
pnpm install       # 装依赖
pnpm build         # 编译（tsc）
pnpm dev           # 编译+启动
pnpm test          # 单测（16 用例）
pnpm dist          # 打包安装包（out\）
node scripts/verify-kernel-lifecycle.cjs   # 内核生命周期自检 9 项
node scripts/verify-provider-theme.cjs     # Provider/主题自检 17 项
```

- 技术栈：Electron 33 + TypeScript 5.9 + 捆绑 Node 22.21.0（内核运行时）+ pnpm 9 + node:test + electron-builder 25；
- 内核 = `@deepseek-ai/dsh` 全家桶（195 个包），以子进程方式运行，**未修改其任何源码**；
- 项目结构、架构图、新手手搓指南见方案文档 `tt-deepseek-harness-desktop-spec-v5.3.md`。

---

## 声明

- 本项目与 DeepSeek 官方无隶属关系，不包含官方代码或密钥；
- 底层能力归属 DeepSeek Harness 项目（MIT）；
- 使用时请遵守 DeepSeek 服务条款与你所配置模型提供方的使用政策。

---

*Made with ❤️ for DeepSeek Harness users.*
