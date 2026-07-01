<img width="1058" height="768" alt="支付宝微信赞助" src="https://github.com/user-attachments/assets/97d66fe6-34a8-4763-90f3-fe75971b3f94" /><img width="1920" height="962" alt="用AI给Linux系统杀毒1" src="https://github.com/user-attachments/assets/4dc1cb4f-e09d-4fe5-aa9c-c4fbbe9257b0" /><img width="1920" height="1026" alt="自动化操作软件" src="https://github.com/user-attachments/assets/d522ffb6-14c3-454e-869a-52c68aba975d" /># VoldpAiAgent
重磅发布！火山AI智能体（别名：火山爱马仕、火山龙虾、火山克劳德；英文名：VoldpAiAgent、VoldpHermes、VoldpClaw、VoldpClaude）。

耗时30天，我基于开源项目 HermesAgent，使用国产编程语言“火山语言”开发了一套跨平台 Go 服务端，并打造了对中文用户友好的前端 AI 智能体。

双模式自由切换：内置 Hermes Agent 模式与 Claude Code 模式，按需选择，灵活应对不同任务。

跨平台开箱即用：提供 Windows、Linux、macOS、Android 等多平台二进制文件，下载即用，无需复杂部署。

大模型友好接入：兼容多种 API 格式，可轻松对接本地部署的各种大语言模型。

多会话高并发：支持多个聊天同时进行，轻松组建“一个人的公司”，批量创建“虚拟数字员工”协同工作。

我主要深耕自动化领域，后续将持续迭代，逐步解锁自动化办公、自动化玩游戏、配合脑机接口操控无人机与机器人、自动操作 CNC 数控机床等强大能力。

项目核心代码完全开源免费，持续更新，欢迎一起探索智能自动化的无限可能。


<img width="1920" height="962" alt="网络搜索资讯" src="https://github.com/user-attachments/assets/e1afffce-0154-4d96-b35d-141b992be0d4" />
<img width="1920" height="962" alt="软件编程开发" src="https://github.com/user-attachments/assets/fccaa4eb-90ee-4399-b203-79081e9bec33" />
<img width="1920" height="962" alt="创建一个为你工作的团队" src="https://github.com/user-attachments/assets/cc9f9738-7c2c-4784-83d9-aeef1d58dc62" />
<img width="1920" height="962" alt="MCP功能" src="https://github.com/user-attachments/assets/a6fc93aa-d92e-486b-8e61-5efdace818fe" />
<img width="1920" height="1026" alt="自动化操作软件" src="https://github.com/user-attachments/assets/e92029de-7dde-4371-8686-ebff7cdb9e61" />
<img width="1662" height="900" alt="运行在Linux系统上" src="https://github.com/user-attachments/assets/16afe126-2c90-4e92-9dd8-515385b92233" />
<img width="1920" height="962" alt="用AI给Linux系统杀毒" src="https://github.com/user-attachments/assets/626e2301-4a93-4024-a57b-791faa2092a8" />
<img width="1920" height="962" alt="用AI给Linux系统杀毒1" src="https://github.com/user-attachments/assets/a7c3fda6-cb9b-48fc-9483-d9f73d698945" />

# VoldpAiAgent · 火山AI智能体

<div align="center">

[![License](https://img.shields.io/badge/License-MIT-blue)](#开源协议)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Android-informational)](#环境要求)
[![Language](https://img.shields.io/badge/Stack-火山服务器软件开发平台%20%2B%20Go%20%2B%20SQLite-success)](#技术栈)
[![WebUI](https://img.shields.io/badge/WebUI-原生JS-FF7A00)](#技术栈)
[![Port](https://img.shields.io/badge/默认端口-8787-9cf)](#快速开始)

</div>

VoldpAiAgent（火山AI智能体）是一个基于**火山服务器软件开发平台（Voldp Server Software Development Platform，简称“火山语言”）**编程技术开发的服务器项目，内置完整的 AI 智能体 Web 界面，把多模型对话、看板任务、技能、记忆、插件、MCP、定时任务和工作区集中到一个本地服务里，通过浏览器即可使用。项目使用火山语言编写、生成 Go 服务器可执行程序，支持 Windows、Linux、macOS、Android 多平台部署。

<p align="center">
  <a href="#核心特性">核心特性</a> · <a href="#快速开始">快速开始</a> · <a href="#配置说明">配置说明</a> · <a href="#使用指南">使用指南</a> · <a href="#开发说明">开发说明</a>
</p>

---

## 项目简介

VoldpAiAgent 是一个用火山语言编写、生成 Go 服务器可执行程序的 AI 智能体平台。火山语言的 `.wsv` 源文件以中文命名，并通过 `# @` 前缀在文件内嵌入原生 Go 代码，最终由火山服务器软件开发平台 IDE 编译为基于 [gin](https://github.com/gin-gonic/gin) 的 HTTP 服务器。

- **核心能力**：开箱即用的多模型 AI 对话、看板任务自动派发与执行、技能/记忆/插件体系、MCP 协议集成、Cron 定时任务、内置终端与 Git 集成。
- **适用场景**：个人本地 AI 工作台、团队内部 AI 助手、需要在前端界面中编排 Agent 任务流和技能调用的开发场景。
- **跨平台支持**：编译产物为单个独立可执行文件，可在 Windows、Linux、macOS、Android（arm64/amd64）上运行；内置终端已针对各平台 shell（cmd.exe / bash / zsh）做回显与编码适配。
- **运行形态**：编译后得到一个独立可执行文件，启动后监听 `http://127.0.0.1:8787`，前端静态文件随程序分发。

---

## 核心特性

- **AI 对话**：支持多模型供应商（DeepSeek、硅基流动、MiMo、自定义 OpenAI 兼容接口），支持推理模型（GLM-Z1、DeepSeek-R1 等），流式输出。
- **看板任务系统**：`分流(triage) → 待办(todo) → 就绪(ready) → 运行中(running) → 已完成(done) / 已阻塞(blocked) / 已归档(archived)` 状态流转，自动派发，独立 worker 进程执行任务。
- **技能系统**：基于 `SKILL.md` 元数据，支持热重载与斜杠命令调用。
- **记忆系统**：`SOUL.md` / `USER.md` / `MEMORY.md` 个人记忆，跨会话持久化。
- **插件系统**：从 `~/.hermes/plugins/` 目录加载，基于 `manifest.json` 描述。
- **MCP 协议**：模型上下文协议（Model Context Protocol）集成，可挂载外部工具。
- **Cron 定时任务**：内置定时调度，按表达式周期性触发任务。
- **工作区**：文件树浏览、文件预览、Artifacts 渲染，文件上传带实时进度条。
- **多 Profile**：每个 profile 拥有独立配置目录，可在前端切换。
- **状态同步**：可选把运行状态同步到洞察（insights）。
- **终端面板**：前端内置终端，可在浏览器中执行命令；已适配 Windows（cmd.exe）、Linux/macOS（bash/zsh）的回显与编码，支持键盘与鼠标粘贴。
- **Git 集成**：工作区 Git 操作、Worktree、代码改动可视化。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 编程语言 | 火山语言（`.wsv`，中文命名 + 嵌入式 Go） |
| 后端框架 | [Gin](https://github.com/gin-gonic/gin) |
| 数据库 | SQLite（`httpServer.db`），ORM 使用 [GORM](https://gorm.io) |
| 认证 | JWT（[golang-jwt/jwt/v5](https://github.com/golang-jwt/jwt)）、Passkey |
| 前端 | 原生 HTML + JS（非框架） |
| 配置 | `config.yaml` + 环境变量（`HERMES_` 前缀）+ 数据库 settings 表 |
| 项目文件 | `VoldpAiAgent.vprj`（项目标识符 `wutao.vproject.pc.server.1`） |
| 支持平台 | Windows、Linux、macOS、Android（arm64/amd64） |

> 说明：本项目是火山服务器项目，**不是**传统 Go 项目，仓库根目录没有 `go.mod`。Go 依赖通过火山服务器软件开发平台 IDE 在 `.wsv` 文件的 `@服务器.导入` 指令中声明，由 IDE 在编译时统一解析。

---

## 项目结构

```text
VoldpAiAgent/
├── VoldpAiAgent.vprj            # 火山服务器软件开发平台项目文件（IDE 打开入口）
├── providers.json               # 模型供应商健康检查结果 / 配置
├── httpServer.db                # SQLite 数据库（运行时生成）
├── src/                         # 火山语言源码（.wsv，60+ 文件，中文命名）
│   ├── main.wsv                 # 程序入口（启动类）
│   ├── 配置.wsv                  # 配置管理（环境变量 / YAML / 数据库合并链）
│   ├── 配置文件.wsv              # Profile 多配置 CRUD 与切换
│   ├── 路由.wsv                  # HTTP 路由注册（312 条路由）
│   ├── 供应商.wsv                # 模型供应商管理
│   ├── 看板桥接.wsv              # 看板任务系统
│   ├── 技能使用.wsv              # 技能系统
│   ├── 插件.wsv                  # 插件加载
│   ├── 终端.wsv                  # 内置终端
│   ├── Git工作区.wsv             # Git 集成
│   ├── 工作区.wsv                # 工作区 / 文件树
│   ├── 认证.wsv / OAuth.wsv / Passkey.wsv
│   ├── 平台*适配器.wsv           # Telegram / 微信 / 飞书 / 钉钉 / WhatsApp
│   └── static/                  # 前端静态文件
│       ├── index.html
│       ├── ui.js / messages.js / sessions.js / workspace.js / terminal.js
│       ├── style.css
│       └── vendor/              # 第三方前端库（js-yaml、katex、smd）
├── build_android.ps1            # Android 交叉编译脚本（需配合 NDK）
└── _backup/                     # 历史改动备份
```

---

## 快速开始

### 环境要求

- **开发工具**：[火山服务器软件开发平台 IDE](https://www.voldp.com/)（Windows 平台，用于打开 `.vprj` 项目并将 `.wsv` 源码编译为 Go 二进制）。IDE 内置 Go 编译链，**无需单独安装 Go 环境**。
- **运行依赖**：运行时仅需编译产物可执行文件本身（前端静态文件已内嵌于二进制，运行时自动释放），无外部依赖。
- **支持平台**：Windows、Linux、macOS、Android（arm64/amd64）。

> 说明：火山服务器软件开发平台 IDE 仅在 Windows 上运行，因此**编译过程必须在 Windows 上完成**。但编译产物可交叉编译为各平台二进制，拷贝到目标平台运行。

### 获取源码

```bash
git clone <your-repo-url> VoldpAiAgent
cd VoldpAiAgent
```

### 打开项目

用火山服务器软件开发平台 IDE 打开根目录下的 `VoldpAiAgent.vprj`。项目标识符为 `wutao.vproject.pc.server.1`，IDE 会自动识别为火山服务器项目。

### 配置

按需编辑以下任一配置来源（优先级见 [配置说明](#配置说明)）：

1. 编辑 `providers.json` 或在前端「设置」中添加模型供应商与 API Key。
2. 在 Home 目录下创建 `config.yaml`（路径见下文）。
3. 通过环境变量覆盖（`HERMES_` 前缀）。

### 编译与运行（按平台）

#### Windows

1. 在火山服务器软件开发平台 IDE 中点击「编译」生成 `VoldpAiAgent.exe`。
2. 直接双击运行编译产物，或在 IDE 中点击「运行」。
3. 控制台将输出：

```text
[webui] VoldpAiAgent 火山语言版本启动中...
[ok] 配置初始化完成, 端口: 8787
  VoldpAiAgent listening on http://127.0.0.1:8787
  Then open:     http://localhost:8787
```

#### Linux

火山 IDE 仅支持 Windows，需先在 Windows 上用 IDE 编译生成 `.go` 中间文件，再用 IDE 内置 Go 工具链交叉编译为 Linux 二进制：

1. 在 Windows 的火山 IDE 中先编译一次任意平台（如 Windows），生成 `_int\VoldpAiAgent\release\project` 下的 `.go` 文件与 `go.mod`。
2. 用 IDE 内置 Go（路径形如 `E:\voldev25\plugins\vprj_server\sdk\GoLang\go1.26.2\bin\go.exe`）在项目目录执行交叉编译：

```powershell
$env:GOOS="linux"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
& "E:\voldev25\plugins\vprj_server\sdk\GoLang\go1.26.2\bin\go.exe" build -o VoldpAiAgent_linux_amd64 ".\rg_volcano_app"
```

3. 将 `VoldpAiAgent_linux_amd64` 上传到 Linux 服务器（前端静态文件已内嵌于二进制，运行时自动释放，无需额外上传 `static/` 目录）。
4. 在 Linux 上赋权并运行：

```bash
chmod +x VoldpAiAgent_linux_amd64
./VoldpAiAgent_linux_amd64
```

> 如需 arm64，将 `GOARCH` 改为 `arm64`。Linux 下若需 SQLite cgo，需配置对应平台的 C 编译器。

#### macOS

与 Linux 同理，交叉编译时设置：

```powershell
$env:GOOS="darwin"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
```

arm64（Apple Silicon）将 `GOARCH` 改为 `arm64`。编译产物 `VoldpAiAgent_darwin_*` 拷贝到 Mac 上运行（前端静态文件已内嵌，无需额外携带 `static/`）：

```bash
chmod +x VoldpAiAgent_darwin_arm64
./VoldpAiAgent_darwin_arm64
```

> 首次运行若被 macOS Gatekeeper 拦截，在「系统设置 → 隐私与安全性」中点击「仍要打开」放行，或在终端执行 `xattr -d com.apple.quarantine VoldpAiAgent_darwin_arm64`。

#### Android

Android 需通过 [NDK](https://developer.android.com/ndk) 交叉编译，项目根目录提供 `build_android.ps1` 脚本：

**前提条件：**
1. 已在火山 IDE 中编译过任意平台（生成 `_int\VoldpAiAgent\release\project` 下的 `.go` 文件）。
2. 已安装 NDK 27（脚本默认路径 `E:\androidSDK\ndk\27.0.12077973`，可按需修改）。
3. 火山 IDE 内置 Go 位于 `E:\voldev25\plugins\vprj_server\sdk\GoLang\go1.26.2`。

**编译：**

```powershell
# 编译 arm64（默认，大多数 Android 设备）
.\build_android.ps1
# 编译 amd64（模拟器 / x86_64 设备）
.\build_android.ps1 -Arch amd64
# 同时编译两个架构
.\build_android.ps1 -Arch both
```

产物输出到 `_int\VoldpAiAgent\release\linker\VoldpAiAgent_android_arm64`（API level 30，兼容 Android 11+）。

**部署到设备：**

```bash
# 通过 adb 推送到设备并赋予执行权限
adb push VoldpAiAgent_android_arm64 /data/local/tmp/
adb shell chmod +x /data/local/tmp/VoldpAiAgent_android_arm64
adb shell /data/local/tmp/VoldpAiAgent_android_arm64
```

> Android 设备需开启「USB 调试」并通过 adb 连接。前端静态文件已内嵌于二进制，运行时自动释放，无需额外推送 `static/` 目录。运行后通过 `http://127.0.0.1:8787` 在设备浏览器访问，或用 `adb forward tcp:8787 tcp:8787` 转发到电脑访问。

### 访问

浏览器打开 [http://127.0.0.1:8787](http://127.0.0.1:8787) 即可进入 Web 界面。首次访问如设置了密码（`HERMES_WEBUI_PASSWORD`）需先登录。

> 若服务监听 `0.0.0.0`（通过 `HERMES_WEBUI_HOST=0.0.0.0` 配置），局域网其他设备可通过 `http://<本机IP>:8787` 访问，生产环境务必同时配置 `HERMES_ALLOWED_ORIGINS` 与访问密码。

---

## 配置说明

### 配置合并链

VoldpAiAgent 的配置来自多个来源，按以下优先级从低到高合并（后者覆盖前者）：

```text
默认值  <  config.yaml 文件  <  数据库 settings 表  <  环境变量（HERMES_）  <  内存覆盖
```

### Home 目录

- Windows 下默认位于 `%LOCALAPPDATA%\hermes`（旧版 `%USERPROFILE%\.hermes` 在新位置无状态时回退使用）
- Linux / macOS / Android 下默认位于 `~/.hermes`
- 可通过环境变量 `HERMES_HOME` 覆盖
- 该目录用于存放 `config.yaml`、`active_profile`、profiles 子目录等

### config.yaml

主配置文件，默认路径为 `$HERMES_HOME/config.yaml`，可通过 `HERMES_CONFIG_PATH` 覆盖。常用字段包括 `host`、`port`、`model`、`provider`、`context_length`、`threshold_tokens`、`max_upload_mb`、`request_timeout`、`ai_request_timeout`、`log_level`、`cors_origin` 等。

### 环境变量

常用环境变量（均以 `HERMES_` 前缀）：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `HERMES_HOME` | 应用主目录 | Windows: `%LOCALAPPDATA%\hermes`；其他平台: `~/.hermes` |
| `HERMES_CONFIG_PATH` | `config.yaml` 路径 | `$HERMES_HOME/config.yaml` |
| `HERMES_WEBUI_HOST` | 监听主机 | `127.0.0.1` |
| `HERMES_WEBUI_PORT` | 监听端口 | `8787` |
| `HERMES_WEBUI_PASSWORD` | Web 登录密码（哈希） | 空（无密码） |
| `HERMES_WEBUI_DEFAULT_MODEL` | 默认模型 | 空 |
| `HERMES_WEBUI_DEFAULT_PROVIDER` | 默认供应商 | 空 |
| `HERMES_WEBUI_DEFAULT_WORKSPACE` | 默认工作区目录 | 当前目录 |
| `HERMES_WEBUI_STATE_DIR` | 状态目录 | `$HERMES_HOME/webui` |
| `HERMES_WEBUI_CONTEXT_LENGTH` | 上下文长度 | `128000` |
| `HERMES_WEBUI_THRESHOLD_TOKENS` | 上下文压缩阈值 | `115200` |
| `HERMES_WEBUI_MAX_UPLOAD_MB` | 上传大小上限（MB） | `50` |
| `HERMES_WEBUI_REQUEST_TIMEOUT` | 请求超时（秒） | `300` |
| `HERMES_WEBUI_AI_REQUEST_TIMEOUT` | AI 请求超时（秒） | `600` |
| `HERMES_WEBUI_CUSTOM_MODELS_TIMEOUT` | 自定义模型端点探测超时（秒） | `5` |
| `HERMES_WEBUI_MAX_SESSIONS` | 最大会话数 | `1000` |
| `HERMES_WEBUI_CORS_ORIGIN` | CORS 允许来源 | 空 |
| `HERMES_WEBUI_LOG_LEVEL` | 日志级别 | `info` |
| `HERMES_WEBUI_DEBUG` | 调试模式（`true` 开启） | 空 |
| `HERMES_WEBUI_TLS_CERT` / `HERMES_WEBUI_TLS_KEY` | TLS 证书 / 密钥路径 | 空（关闭 TLS） |
| `HERMES_WEBUI_PASSKEY` | 启用 Passkey 登录（`true` 开启） | 空 |
| `HERMES_WEBUI_ONBOARDING_OPEN` | 开放引导流程（`1` 开启） | 空 |
| `HERMES_KANBAN_TASK_ID` | 看板 worker 模式任务 ID（存在则进入 worker 模式，跳过 HTTP 服务） | 空 |

### Profile 系统

- 每个 Profile 拥有独立配置目录，位于 `$HERMES_HOME/profiles/<name>/`（`default` 直接使用 `$HERMES_HOME`）。
- 当前活跃 Profile 记录在 `$HERMES_HOME/active_profile` 文件中。
- 可在前端界面创建、切换、删除 Profile，实现多套配置互不干扰。

### providers.json

模型供应商配置文件，内置支持以下供应商类型：

| 供应商 | 说明 |
|--------|------|
| `deepseek` | DeepSeek 官方接口（含 DeepSeek-R1 推理模型） |
| `硅基流动` | 硅基流动聚合平台（数十个模型可选） |
| `MiMo` | MiMo 模型接口 |
| `custom` | 任意 OpenAI 兼容接口（自定义 `base_url` 与 `api_key`） |

供应商的 API Key、Base URL 等可在前端「设置 → 供应商」中维护，或直接编辑 `providers.json`。健康检查接口会探测各供应商的可达性与延迟。

---

## 使用指南

启动服务并打开 Web 界面后，主要功能入口如下（详细使用说明请参考仓库内的 `使用指南.md`）：

- **AI 对话**：在会话页选择模型与供应商，输入消息即可对话；推理模型会展示思考过程。
- **看板任务**：在看板面板创建任务，系统按 `分流 → 待办 → 就绪 → 运行中 → 已完成 / 已阻塞` 流转并派发给 worker 执行。
- **技能调用**：在输入框使用斜杠命令（如 `/skill-name`）触发已加载技能；技能支持热重载。
- **记忆管理**：在记忆面板编辑 `SOUL.md` / `USER.md` / `MEMORY.md`，跨会话生效。
- **工作区**：在工作区面板浏览文件树、预览文件、查看 Artifacts，上传文件带实时进度条。
- **终端**：打开终端面板在浏览器中执行命令，已适配各平台 shell 回显与编码。
- **多 Profile**：在设置中切换 Profile，配置隔离互不影响。

---

## 开发说明

### `.wsv` 文件格式

- `.wsv` 是火山语言的源文件格式，文件头部为 `<火山程序 类型 = "通常" 版本 = 1 />`。
- 火山语言部分使用中文关键字（如 `类`、`方法`、`变量`、`如果`、`返回`）。
- 嵌入式 Go 代码以 `# @` 为行前缀，编译时会被原样并入生成的 Go 源码；Go 导入通过 `@服务器.导入 = "..."` 在类声明处声明。
- 文件中存在大量 `Rg_` 开头的 Go 函数，作为火山类方法的嵌入式实现桥接（全项目 860+ 个）。

### 前端静态文件

- 位置：`src/static/`，在 `.vprj` 中通过 `@服务器.附属文件 = "static > static"` 声明，编译时自动复制到可执行文件同目录。
- 入口：`src/static/index.html`，主要逻辑分散在 `ui.js`、`messages.js`、`sessions.js`、`workspace.js`、`terminal.js` 等原生 JS 文件中。
- 第三方库位于 `src/static/vendor/`（js-yaml、katex、smd）。

### 添加新 HTTP 路由

1. 在 `src/路由.wsv` 的 `注册所有路由` 方法中，参考已有路由写法，使用 `Gin引擎类` 注册新路径。
2. 路由处理逻辑可放在对应的业务 `.wsv` 文件中，通过 `Rg_` 前缀的嵌入式 Go 函数实现。
3. 路由注册必须在静态文件服务（`注册静态文件服务`）之前完成，以避免通配路由冲突。
4. 当前项目共注册 312 条 HTTP 路由，涵盖会话、消息、供应商、看板、技能、插件、工作区、终端、Git、Profile 等模块。

### 看板 worker 模式

当环境变量 `HERMES_KANBAN_TASK_ID` 非空时，程序进入 worker 模式：加载指定任务 → 调用 LLM 执行 → 标记 `done` 或 `blocked` → 退出，**不启动 HTTP 服务器**。该模式由主服务在派发任务时以子进程方式调用。

---

## 路线图

- [ ] 前端从原生 JS 逐步迁移到组件化结构
- [ ] 完善 MCP 工具市场与权限审批流
- [ ] 增加更多模型供应商预设
- [ ] 完善 Android 平台的终端与 IM 适配器适配
- [ ] 提供 Linux/macOS 一键交叉编译脚本

---

## 贡献指南

欢迎通过 Issue 和 Pull Request 参与贡献：

1. Fork 仓库并创建特性分支（`feat/xxx`、`fix/xxx`）。
2. 修改请在火山服务器软件开发平台 IDE 中完成并通过编译，确保不破坏现有路由与配置合并链。
3. 提交信息建议使用 Conventional Commits 风格（`feat:`、`fix:`、`docs:`）。
4. PR 请说明改动范围、影响的模块（路由 / 配置 / 前端 / 数据库等）以及验证方式。

---

☕ 请作者喝杯咖啡

如果这个项目对您有帮助，欢迎打赏支持，您的每一份支持都是我持续更新的动力 ❤️

<img width="1058" height="768" alt="支付宝微信赞助" src="https://github.com/user-attachments/assets/7d265e92-2433-46c7-8a9e-c6748d755257" />


如果这个项目对您有帮助，请给个 ⭐ Star 支持一下，让更多的人看到 Claude Code Haha！

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

---

## 免责声明

本项目仅供学习与技术研究使用，不提供任何明示或暗示的担保。使用者应自行承担因使用本项目而产生的任何风险与责任。项目中涉及的所有第三方模型、API、前端资源的版权归各自所有者所有，使用时请遵循对应的服务条款与开源协议。
