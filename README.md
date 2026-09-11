# TT DeepSeek Harness Desktop (v0.4.0)

> **非官方项目**：基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的 Windows 桌面封装，与 DeepSeek 官方无隶属关系。素材（Roxy 宠物图）禁商用。

把官方 DSH 全家桶装进 Windows 桌面：双击即用（免装 Node.js）、窗口即完整 DSH Web UI、**应用内手动更新内核**（官方 npm 源 / 国内镜像，自检 + 自动回滚）、**插件管理**（开关 / 本地导入 / 移除可恢复）。

![Tauri](https://img.shields.io/badge/Tauri-2-FFC131) ![Rust](https://img.shields.io/badge/Rust-stable%20GNU-DEA584) ![Node](https://img.shields.io/badge/Bundled%20Node-22.21.0-339933) ![DSH](https://img.shields.io/badge/dsh-0.1.0--rc.6-4D7CFE) ![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)

## 功能

- **双击即用**：捆绑内核（node.exe + 788 包）随应用分发，自动拉起 + 崩溃自愈（退避 1s/4s/16s ×3）
- **内核管理**（托盘 → 设置）：检查官方 npm 源全部版本（默认 npmmirror 镜像，可切 npmjs）→ 下载 → sha512 校验（fail-closed，不落盘不解压）→ staging 自检 → 原子切换 → 健康失败自动回滚；保留上一版本备份，一键回滚
- **插件管理**：列表 / 按名开关（官方用户层 disabled 条目机制）/ 导入本地插件目录（校验 package.json + cordis.patch.yml）/ 移除进 plugin-trash（手工可恢复）；坏插件标红不阻塞启动；启动时自动清理失效 junction（卸载插件/换目录后自愈）
- **桌面集成**：伊蕾娜图标（托盘 / 任务栏 / 安装器同源 ico）、托盘（显示主窗 / 设置 / Roxy 开关 / 退出）、关闭 × 弹三选项对话框（退出到托盘 / 关闭程序 / 取消，可勾选「不再弹出询问」）、单实例
- **安全**：内核下载校验不过不执行、不跑任何包安装脚本、tar 条目拒绝路径穿越与硬链接、API Key 只进 Windows 凭据管理器（由 DSH Web 内配置）

## 分发给他人

安装包：`out/TT DeepSeek Harness Desktop_0.4.0_x64-setup.exe`。

对方电脑**不需要任何开发环境**：Node、内核、WebView2Loader、安装器全部随包自带，无需管理员权限（装用户目录），支持中文安装路径。仅两件事依赖对方电脑：

1. **WebView2 运行时**：Win11 / 近年 Win10 自带；精简版/老 Win10 没有时，安装器内嵌引导器会自动安装（需联网）。完全离线的无 WebView2 机器需先手动装 WebView2 运行时
2. **联网**：仅对话（你配置的模型 API）与内核更新检查需要；安装与本地使用本身不需要

## 一键启动 / 一键关闭

- **一键启动.cmd**：启动应用（已构建 release 优先，其次 debug；应用自带单实例，重复启动会聚焦已有窗口）
- **一键关闭.cmd**：关闭应用并清理内核/安装器的 node 进程（只匹配本项目内核的命令行，不影响其他 node 程序）

## 从源码运行 / 测试

```powershell
# 前置：Rust stable（GNU 工具链）+ mingw64 在 PATH
cargo test --manifest-path src-tauri/Cargo.toml      # Rust 单测
node --test scripts/test/install-kernel.test.mjs     # 安装器单测（含本地假 registry E2E）
node scripts/verify-kernel.cjs                       # 内核自举 HTTP 200
node scripts/verify-kernel-update-v8.cjs             # 内核更新管线（含篡改 fail-closed）
node scripts/verify-plugins.cjs                      # 插件挂载/禁用往返（真实内核）
cargo run --manifest-path src-tauri/Cargo.toml       # 开发运行
```

## 安装与卸载

- **安装**：向导式安装，**安装目录在向导里自选**（默认 `%LOCALAPPDATA%\TT DeepSeek Harness Desktop`，可改到任意可写目录，支持中文路径）； NSIS 为 Unicode 构建
- **卸载**：控制面板/开始菜单卸载。会删除安装目录内全部内容（含更新产生的 `kernel-staging`/`kernel-backup`）；卸载前自动摘除 `dsh-home` 里的插件 junction，不会误删插件源目录；**会话数据默认保留**，卸载向导里勾选“删除应用数据”才一并清除

## 数据在哪（卸载不自动删）

| 内容 | 路径 |
|---|---|
| 全部应用数据 | `%APPDATA%\tt-deepseek-harness-desktop\` |
| 会话 / 工作区 | 上述目录 `dsh-home\` |
| 日志 | `logs\main.log`（壳+审计）、`logs\kernel.log`（内核）、`logs\installer-*.log`（更新） |
| 内核下载缓存 | `kernel-cache\`（只留最近一次成功集合，设置页可清理） |
| 被移除的插件 | `plugin-trash\<id>-<时间戳>\`（移回 `plugins\` 目录并重启可恢复） |
| API Key | Windows 凭据管理器（DSH 条目） |

## 内核更新常见问题

- **检查/安装失败**：先切镜像重试（设置 → 内核管理 → 源下拉）；`E_INTEGRITY` 多为镜像同步异常，清缓存重试
- **更新后起不来**：应用自动回滚到上一版本；若回滚也失败，看 `logs\installer-*.log`
- **磁盘**：更新需 ≥1.5GB 可用空间（staging + 备份 + 余量）
- **想彻底清理**：删除上表「全部应用数据」目录即可（会丢会话）

## 目录结构（开发）

```
src-tauri/
  crates/shell-core/       # 设置(归一化/迁移) / 插件发现 / junction / 用户patch层 / 路径
  crates/kernel-process/   # 内核进程: spawn/端口/健康/退避/杀树
  crates/kernel-update/    # 更新: semver/换名回滚/状态机/安装器桥
  src/app/                 # Tauri 装配: supervisor/托盘/窗口/命令/设置窗口页
resources/installer/       # install-kernel.cjs（零依赖 Node 安装器）
kernel/                    # 内核载荷（更新器只整目录换名）
plugins/                   # 内置插件（dsh-pet-roxy；tt-bg 已于 0.4.0 移除）
scripts/                   # flatten/verify 脚本 + installer 单测
out/                       # 打包产物（Setup.exe）
```

规格文档：`../tt-deepseek-harness-desktop-spec-v8.0.md`（含执行计划、威胁模型、问题记录）。
