# TT DeepSeek Harness Desktop

> **非官方项目**：基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的 Windows 桌面封装，与 DeepSeek 官方无隶属关系。

**把 DeepSeek Harness 的 Web UI 装进原生桌面窗口：托盘常驻 · 内核自愈 · Provider 加密管理 · 主题联动**

![Electron](https://img.shields.io/badge/Electron-33-47848F) ![Node](https://img.shields.io/badge/Bundled%20Node-22.21.0-339933) ![DSH](https://img.shields.io/badge/dsh-0.1.0--rc.6-4D7CFE) ![License](https://img.shields.io/badge/license-MIT-green)

---

## 目录

- [特性](#特性)
- [架构](#架构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [数据与安全](#数据与安全)
- [Provider 与密钥](#provider-与密钥)
- [主题](#主题)
- [打包与发布](#打包与发布)
- [测试与验证](#测试与验证)
- [项目结构](#项目结构)
- [常见问题（FAQ）](#常见问题faq)
- [路线图](#路线图)
- [声明](#声明)

---

## 特性

| 特性 | 说明 |
|---|---|
| 🪟 桌面化 Web UI | 原生 Electron 窗口加载 DSH Web UI（`http://127.0.0.1:<端口>`），保留完整对话/工作流/工具能力 |
| 🖥️ 托盘常驻 | 关闭窗口最小化到托盘；托盘菜单可显示/退出 |
| ♻️ 内核自愈 | 内核子进程崩溃后自动重启（指数退避 1s/4s/16s，最多 3 次），窗口自动复用并刷新到新端口，不重复建窗 |
| 🔒 Provider 管理 | DeepSeek 官方 / OpenAI-compatible / Ollama / LM Studio / llama.cpp / vLLM；API Key 经 `safeStorage` 密文落盘（磁盘无明文） |
| 🔗 一键同步到 DSH | 保存 Provider 后自动写入 DSH `settings.yaml` 的 `llm-pi-ai.providers` 段（热重载，Web UI 模型选择器即刻可用），密钥经内核环境变量注入（`TT_DSH_KEY_<ROUTE>`） |
| 🌗 主题联动 | 亮 / 暗 / 跟随系统三态，直接驱动 DSH 前端（写 `ui-theme.preference`，非 CSS 覆盖） |
| 🚀 自包含内核 | 捆绑 Node 22.21.0 运行 dsh 内核（Electron 内置 Node 20.18 实测无法加载 dsh rc.6 的 web profile） |
| 📦 一键打包 | electron-builder + NSIS 产出 Windows 安装包（约 145MB，含完整内核与依赖闭包） |
| 🧪 可验证 | `node:test` 单测 16/16、内核生命周期 9/9、Provider/主题 14/14 全部实测通过 |

---

## 架构

```text
┌───────────────────────────────────────────────────────────────┐
│ Electron 主进程（main，CommonJS，dist/main.js）                  │
│  Window / Tray / IPC / Provider / 主题 / ServiceManager          │
│  DSH_HOME = <userData>/dsh-home（与系统 ~/.dsh 完全隔离）          │
├───────────────────────────────────────────────────────────────┤
│ 内核子进程（spawn 捆绑 Node 22.21.0 node.exe）                    │
│  运行 @deepseek-ai/dsh/lib/bin.js web --port <预占端口>           │
│  = Cordis 运行时 + host-webserver + 全部 dsh 插件                 │
├───────────────────────────────────────────────────────────────┤
│ 渲染进程（BrowserWindow，Chromium）                              │
│  加载 http://127.0.0.1:<实际端口>；preload 暴露 window.dshDesktop │
└───────────────────────────────────────────────────────────────┘
```

**关键设计**：

1. **内核 = 独立进程 + 捆绑 Node**：内核跑在随应用分发的 Node 22.21.0 上（dsh rc.6 需要 `node:zlib` zstd（22.13+）与 `node:module` 类型剥离（22.18+），Electron 内置 Node 20.18 无法启动）。
2. **就绪信号 = 预占端口 + 健康轮询**：主进程先占一个空闲端口传给内核（等价 `--port 0`），再轮询 `GET /` 直至 200 才宣告就绪——打包后无控制台环境同样可靠。
3. **内核日志落盘** `<userData>/logs/kernel.log`（stdout/stderr 重定向到文件，不依赖管道）。
4. **数据隔离**：应用数据全部在 `%APPDATA%\tt-deepseek-harness-desktop`（Electron userData），**从不读写系统 `~/.dsh`**（那是 DeepSeek Harness CLI 的 home，互不干扰）。

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | 10/11 x64 | 主目标平台（NSIS 安装包） |
| Node.js | ≥ 22.12（开发机） | 构建与测试用；**运行时内核用捆绑的 Node 22.21.0** |
| pnpm | 9.x | `npm i -g pnpm@9` |
| Git | ≥ 2.43 | 版本管理 |

macOS / Linux 构建配置已就绪（dmg / AppImage+deb），但仅 Windows 经过完整验证。

---

## 快速开始

```powershell
# 1) 获取源码
git clone <your-repo-url> tt-deepseek-harness-desktop
cd tt-deepseek-harness-desktop

# 2) 安装依赖（首次约 10-15 分钟，含 electron 二进制下载）
pnpm install

# 3) 构建
pnpm build

# 4) 开发启动（编译后启动 Electron，窗口加载 DSH Web UI）
pnpm dev

# 5) 运行单测
pnpm test

# 6) 打包 Windows 安装包
pnpm dist
# 产物：out\TT DeepSeek Harness Desktop Setup 0.1.0.exe
```

> 网络提示：大陆网络环境建议在安装/打包前设置镜像（本项目实测通过）：
>
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```
>
> 若安装时 TLS 证书校验失败，Node 命令加 `--use-system-ca`。

---

## 使用指南

### 启动与退出

- 双击 `TT DeepSeek Harness Desktop.exe`（开发态 `pnpm dev`）启动；窗口自动加载 DSH Web UI，内核就绪后进入对话界面。
- **关闭窗口 → 最小化到托盘**（进程常驻）。
- **托盘图标 → 退出**：真正退出，内核及其工具子进程（bash/pwsh 等）被整树回收，无残留进程。
- 单实例：重复启动会聚焦已有窗口。

### 内核自愈

在任务管理器杀掉内核进程（`node.exe`，路径含 `resources\node`）后：

1. 主进程检测到退出 → 按 1s / 4s / 16s 指数退避自动重启内核（最多 3 次）；
2. 内核以**新端口**就绪后，主进程自动把现有窗口重载到新地址（不会弹第二个窗口）；
3. 超过 3 次连续崩溃后触发 `exhausted`（预留弹窗提示重置 profile）。

### Provider 管理

当前版本提供程序化接口（图形设置页在路线图中）：

| 方法（`window.dshDesktop.provider.*`） | 说明 |
|---|---|
| `list()` | 列出全部 Provider（Key 不回显，仅 `hasKey`） |
| `save(cfg)` | 新增/更新（Key 走 safeStorage 加密；自动同步 DSH settings.yaml；Key 变更自动重启内核） |
| `remove(id)` | 删除（含密文与 DSH 配置段） |
| `test(id)` | 连通性测试（请求 `/models`） |
| `listModels(id)` | 拉取模型列表 |
| `probeLocal()` | 扫描本机 Ollama/LM Studio/llama.cpp/vLLM/LocalAI 预设端点 |

完整闭环可运行 `node scripts/verify-provider-theme.cjs` 查看（新增→加密落盘→同步 DSH→凭据注入→删除）。

### 主题

调用 `window.dshDesktop.theme.set(...)`（`dark` / `light` / `system`）：

- 写入 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`（DSH 原生主题机制，热重载）；
- 页面 `body[data-ds-dark-theme]` 与 `--dsw-alias-*` 变量联动，亮暗切换即时生效；
- 会话持久化在 `$DSH_HOME/sessions`，切换主题（重载）不丢对话。

---

## 数据与安全

### 数据位置

| 内容 | 位置 |
|---|---|
| Provider 配置（不含 Key） | `%APPDATA%\tt-deepseek-harness-desktop\config\providers.json` |
| API Key 密文（safeStorage 加密） | `%APPDATA%\tt-deepseek-harness-desktop\secrets\<id>.enc` |
| 内核日志 | `%APPDATA%\tt-deepseek-harness-desktop\logs\kernel.log` |
| 隔离的 DSH home（profile/会话/settings.yaml） | `%APPDATA%\tt-deepseek-harness-desktop\dsh-home` |
| 打包产物 | `out/`（项目内） |

### 安全边界

- **系统 `~/.dsh` 零接触**：应用与内核通过 `DSH_HOME` 环境变量强制隔离到 userData 下，与 DeepSeek Harness CLI 的数据完全互不干扰；
- **密钥无明文**：API Key 仅在内存中解密，落盘为 `safeStorage.encryptString` 产物；`providers.json` 只存元数据；
- **凭据闭环**：Key 经内核环境变量 `TT_DSH_KEY_<ROUTE>` 注入（内核启动时收集），DSH 的 `llm-pi-ai.providers.<route>.apiKeyEnv` 按请求解析，不写进任何配置文件；
- **日志脱敏**：内核输出经 `redact` 处理（Bearer / `sk-` / `api_key=` 自动遮蔽）后才落盘；
- **进程边界**：关闭窗口不退出（托盘），显式退出时 `taskkill /T` 整树回收 + `child.kill()` 兜底，杜绝孤儿进程。

### 彻底卸载

```powershell
# 卸载应用后，如需清除全部数据
Remove-Item -Recurse -Force "$env:APPDATA\tt-deepseek-harness-desktop"
# （可选）清理构建缓存
pnpm store prune
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron", "$env:LOCALAPPDATA\electron-builder"
```

---

## Provider 与密钥

### 支持类型

- **DeepSeek 官方**：OpenAI 协议，任意 OpenAI-compatible 端点均可；
- **本地端点预设**（`src/provider/presets.ts`，可用 `probeLocal()` 自动发现）：
  - Ollama `http://127.0.0.1:11434/v1`
  - LM Studio `http://127.0.0.1:1234/v1`
  - llama.cpp server / LocalAI `http://127.0.0.1:8080/v1`
  - vLLM `http://127.0.0.1:8000/v1`
- 自定义 baseURL + 可选 `extraHeaders`。

### 同步到 DSH（providerSync: direct）

保存 Provider 后自动写入 `settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    my-ollama:
      displayName: Ollama
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      apiKeyEnv: TT_DSH_KEY_MY_OLLAMA   # 密钥由内核环境注入，不在文件中
      models:
        - id: llama3.2
          name: llama3.2
```

`dsh-settings-file` 热重载该文件，DSH Web UI 的模型选择器即时出现该 Provider 的模型。

---

## 打包与发布

### 本地打包

```powershell
pnpm dist
# out\TT DeepSeek Harness Desktop Setup 0.1.0.exe（NSIS，约 145MB）
```

要点：

- `asar: false`——内核（纯 Node 子进程）需要直接读取 `node_modules`，且捆绑 Node 随 `extraResources` 分发；
- `win.signAndEditExecutable: false`——本机无符号链接特权时的实测绕行方案；产物为未签名 exe（Windows SmartScreen 可能提示，选择"仍要运行"即可；正式发布建议配置代码签名证书后移除该选项）；
- 首次打包会自动补齐 pnpm peer 依赖（`scripts/add-missing-peers.cjs`——electron-builder 不收集 peer 依赖，实测缺 100+ 包）；
- 图标由 `scripts/make-icon.cjs` 生成占位图（256×256），正式发布前请替换 `resources/icon.ico`。

### CI 三平台构建

`.github/workflows/ci.yml` 已就绪：install（frozen-lockfile）→ build → test → dist → 上传产物（windows/macos/linux 矩阵）。

---

## 测试与验证

| 套件 | 命令 | 覆盖 | 实测结果 |
|---|---|---|---|
| 单元测试 | `pnpm test` | 状态机全转移表、OpenAI 适配器（SSE/超时/mock fetch）、本地探测、主题 token 校验、日志脱敏 | **16/16 通过** |
| 内核生命周期 | `node scripts/verify-kernel-lifecycle.cjs` | 启动→就绪→GET 200→防双开→杀内核自动重启（新进程新端口）→停止无残留 | **9/9 通过** |
| Provider/主题 | `node scripts/verify-provider-theme.cjs` | 密文落盘、DSH 同步格式、凭据注入、主题 settings 读写、多段共存 | **14/14 通过** |

验证脚本不依赖 Electron GUI（mock 主进程 API），可在 CI / 无头环境运行。

---

## 项目结构

```text
tt-deepseek-harness-desktop/
├── src/
│   ├── main.ts                 # 入口：单实例锁、DSH_HOME 隔离、窗口/内核装配
│   ├── window.ts               # 窗口（sandbox preload、关闭→托盘、重启复用）
│   ├── tray.ts                 # 托盘菜单
│   ├── preload.ts              # contextBridge（CJS 自包含）
│   ├── state.ts                # 退出标志
│   ├── service/
│   │   ├── ServiceManager.ts   # 内核子进程：spawn/就绪/自愈/树杀
│   │   ├── health.ts           # GET / 健康检查
│   │   ├── state-machine.ts    # 纯函数状态机
│   │   └── contract.json       # Stage 1 实测契约
│   ├── ipc/                    # IPC 通道与全量 handler
│   ├── provider/               # types/adapters/presets/probe/store/dshSync
│   ├── security/secrets.ts     # safeStorage 封装
│   └── theme/                  # themeManager（settings.yaml 驱动）/tokens
├── tests/                      # node:test 单测（5 文件）
├── scripts/
│   ├── verify-kernel-lifecycle.cjs   # 生命周期验证 9/9
│   ├── verify-provider-theme.cjs     # Provider/主题验证 14/14
│   ├── make-icon.cjs                 # 生成 256×256 ICO
│   └── add-missing-peers.cjs         # 打包依赖补齐
├── resources/
│   ├── node/node.exe           # 捆绑 Node 22.21.0（36MB）
│   ├── icon.ico                # 应用图标
│   └── build/electron-builder.yml
├── .github/workflows/ci.yml    # 三平台 CI
└── package.json
```

---

## 常见问题（FAQ）

### 内核起不来 / 窗口无内容

- 查看 `%APPDATA%\tt-deepseek-harness-desktop\logs\kernel.log`；
- 常见原因：捆绑 Node 版本低于 22.18（缺 zstd / 类型剥离 API）——本项目锁定 22.21.0，勿随意替换 `resources/node/node.exe`；
- 内核反复崩溃 3 次后进入 `exhausted`，重启应用即可。

### 安装包 SmartScreen 提示

未签名所致（`signAndEditExecutable: false`）。开发/自用选"更多信息 → 仍要运行"；正式发布请配置代码签名。

### 想用系统 `~/.dsh` 的既有 profile？

当前设计刻意隔离（防止污染 DeepSeek Harness CLI 数据）。如需打通，可设置环境变量 `DSH_HOME` 指向系统 home 后启动（应用尊重显式设置），风险自负。

### 内存占用偏高？

Electron + Chromium + 内核（V8+Cordis）稳定态约 330–600MB、任务密集时可超 1GB，属方案固有代价（见架构）。窗口隐藏时 `backgroundThrottling` 会降低渲染进程占用。

### 打包体积为什么这么大？

完整携带 dsh 依赖闭包（900+ 包）与捆绑 Node；体积换零联网安装与离线可用。

---

## 路线图

- [x] v0.1 基础：窗口/托盘/内核自愈/Provider 加密存储/DSH 同步/主题/NSIS 打包
- [ ] 图形化 Provider 设置页（当前为 IPC + 脚本接口）
- [ ] 自定义主题导入（`--tt-*` token 体系已预留）
- [ ] 自动更新（electron-updater 已规划）
- [ ] macOS / Linux 完整验证
- [ ] 轻量版：迁移 Tauri（桥接层 `window.dshDesktop` 契约已抽象，内核不变）

---

## 声明

- 本项目与 DeepSeek 官方无隶属关系，不包含官方代码或密钥；
- 底层能力与数据模型归属 DeepSeek Harness 项目（MIT），本项目仅为桌面壳层；
- 使用时请遵守 DeepSeek 服务条款与你所配置模型提供方的使用政策。

---

*Made with ❤️ for DeepSeek Harness users.*
