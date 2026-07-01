# VoldpAiAgent / Volcano AI Agent

<div align="center">

[![License](https://img.shields.io/badge/License-MIT-blue)](#license)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Android-blue)](#requirements)
[![Tech](https://img.shields.io/badge/Tech-Volcano%20Windows-orange)](#tech-stack)
[![Port](https://img.shields.io/badge/Default%20Port-8787-green)](#quick-start)
[![中文](https://img.shields.io/badge/🇨🇳_中文-Available-green)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-当前-blue)](README_EN.md)

</div>

A server project built with Volcano Windows (火山服务器软件开发平台, Voldp Server Software Development Platform) programming technology that delivers an AI agent web interface. VoldpAiAgent is an independent AI agent platform authored in the Volcano language — `.wsv` source files that compile down to Go — combining multi-provider AI chat, a kanban task system, a skill system, persistent memory, plugins, MCP integration, scheduled tasks and a built-in workspace in a single self-contained binary that runs on Windows, Linux, macOS and Android.

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#core-features">Core Features</a> · <a href="#configuration">Configuration</a> · <a href="#usage-guide">Usage Guide</a> · <a href="#development-notes">Development Notes</a>
</p>

---

## Project Introduction

VoldpAiAgent (火山AI智能体) is a server-side AI agent web application authored in the Volcano Windows programming language. Every `.wsv` source file is transpiled into Go and then compiled into a native binary, so the project ships as a single self-contained executable backed by an embedded SQLite database and a static HTML/JS frontend, runnable on Windows, Linux, macOS and Android.

The project is an independent AI agent platform authored in the Volcano language. The backend exposes 312 HTTP routes through the Gin framework, organized across 60+ `.wsv` modules (Chinese-named) and 860+ `Rg_` prefixed helper functions. The frontend is a framework-free HTML + vanilla JS web UI served directly from the binary.

### Core Capabilities

- Multi-provider AI chat with reasoning-model streaming (DeepSeek, SiliconFlow, MiMo, GLM, Kimi, OpenAI-compatible endpoints).
- Kanban task orchestration with worker-process dispatch and `triage → todo → ready → running → done / blocked / archived` status flow.
- Extensible skill system driven by `SKILL.md` metadata, hot-reload and slash commands.
- Persistent personal memory via `SOUL.md` / `USER.md` / `MEMORY.md`.
- Plugin discovery from `~/.hermes/plugins/` with `manifest.json`.
- Model Context Protocol (MCP) tool integration over HTTP/SSE.
- Cron scheduled tasks with run history and manual triggers.
- Workspace panel with file tree, preview, Artifacts and real-time upload progress.
- Multi-profile configuration with independent state directories.
- Built-in terminal panel with per-platform shell echo & encoding adaptation (cmd.exe on Windows, bash/zsh on Linux/macOS), Git integration.

### Use Cases

- A local-first AI coding and task agent on Windows, Linux, macOS or Android.
- A self-hosted chat workspace that unifies multiple LLM providers behind one UI.
- A kanban-driven agent runner where tasks are dispatched to background workers.
- A reference implementation of the Volcano Windows server platform for Chinese-language Go development.

---

## Core Features

| Feature | Description |
|---------|-------------|
| **AI Chat** | Multi-provider chat (DeepSeek, SiliconFlow, MiMo, custom OpenAI-compatible), reasoning model support (GLM-Z1, DeepSeek-R1, etc.) with separate reasoning/thinking stream channels. |
| **Kanban Task System** | `triage → todo → ready → running → done / blocked / archived` status flow, auto-dispatch, isolated worker-process execution (`HERMES_KANBAN_TASK_ID`), per-task run history. |
| **Skill System** | `SKILL.md` metadata, hot-reload, slash commands (`/reload-skills`, `/reload-mcp`, etc.), usage tracking. |
| **Memory System** | Personal memory through `SOUL.md`, `USER.md`, `MEMORY.md`; auto-injected into conversation context; optional OpenAI Embedding vector search. |
| **Plugin System** | Plugins discovered from `~/.hermes/plugins/`, each declaring a `dashboard/manifest.json`; dashboard tabs registered into the UI. |
| **MCP Protocol** | Model Context Protocol integration; reload discovered tools with `/reload-mcp`. |
| **Cron Scheduled Tasks** | Per-job schedule, run history, manual trigger, in-memory run-state tracking. |
| **Workspace** | File tree, preview, Artifacts, blocked system-path protection, real-time upload progress. |
| **Multi-Profile** | Each profile has an independent directory under `profiles/`; active profile stored in `active_profile`. |
| **State Sync** | Optional session metadata sync to `state.db` (enabled via `sync_to_insights`, off by default). |
| **Terminal Panel** | Built-in terminal in the web UI; per-platform shell echo & encoding adaptation (cmd.exe on Windows, bash/zsh on Linux/macOS); keyboard and mouse paste supported. |
| **Git Integration** | Git workspace operations, worktree support, diff review. |

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Language / Platform | Volcano Windows (火山服务器软件开发平台) — `.wsv` source transpiled to Go |
| Embedded code | Go code blocks prefixed with `# @` inside `.wsv` files |
| HTTP framework | [Gin](https://github.com/gin-gonic/gin) |
| ORM | [GORM](https://gorm.io) + SQLite driver |
| Database | SQLite (`httpServer.db`, `kanban.db`, `state.db`) |
| Auth | JWT (`golang-jwt/jwt/v5`), Passkey, optional password hash |
| Frontend | HTML + vanilla JS (framework-free) |
| Static assets | served from `src/static/` via `NoRoute` handler |
| Config | `config.yaml` + `HERMES_` environment variables + DB settings table |
| Protocols | MCP (HTTP/SSE) |
| Supported Platforms | Windows, Linux, macOS, Android (arm64/amd64) |

---

## Project Structure

```
VoldpAiAgent/
├── VoldpAiAgent.vprj              # Volcano Windows project file (identifier: wutao.vproject.pc.server.1)
├── providers.json                 # Model provider health/config snapshot
├── httpServer.db                  # Main SQLite database (sessions, settings, providers, cron)
├── src/                           # Volcano language source (.wsv files, Chinese-named)
│   ├── main.wsv                   # Program entry — startup flow, route registration
│   ├── 配置.wsv                    # Configuration management (YAML / env / DB merge)
│   ├── 配置文件.wsv                 # Profile CRUD and switching
│   ├── 路由.wsv                    # HTTP route registration (312 routes)
│   ├── 路径.wsv                    # Platform-aware path helpers (HERMES_HOME)
│   ├── 网关聊天.wsv                 # Chat gateway, LLM provider dispatch, streaming
│   ├── 供应商.wsv                   # Model provider CRUD
│   ├── 看板桥接.wsv                 # Kanban task bridge (SQLite-backed)
│   ├── 技能使用.wsv                 # Skill usage tracking
│   ├── 插件.wsv                    # Plugin discovery and static serving
│   ├── 终端.wsv                    # Built-in terminal panel
│   ├── 工作区.wsv / Git工作区.wsv    # Workspace & Git operations
│   ├── 状态同步.wsv                 # Optional sync to state.db
│   ├── OAuth.wsv / Passkey.wsv / 认证.wsv   # Auth layers
│   ├── 平台*适配器.wsv              # IM adapters (Telegram, WhatsApp, WeChat, DingTalk, Feishu)
│   └── ...                        # 60+ modules total
│   └── static/                    # Frontend static files
│       ├── index.html             # Web UI entry
│       ├── boot.js, ui.js, panels.js, sessions.js, workspace.js, terminal.js
│       ├── commands.js            # Slash-command handling
│       └── vendor/                # js-yaml, katex, smd
├── build_android.ps1            # Android cross-compile script (requires NDK)
└── _backup/                     # Historical change backups
```

### Key Files

- **`VoldpAiAgent.vprj`** — Volcano Windows project descriptor (`project_identifier = "wutao.vproject.pc.server.1"`). Open this file in the Volcano Windows IDE to build and run.
- **`providers.json`** — Provider health snapshot (reachable, has_key, models_total, latency_ms) for `deepseek`, `硅基流动` (SiliconFlow), `MiMo` and `custom`.
- **`src/main.wsv`** — Program entry. Initializes config, database, sessions, plugins, registers middleware (CORS, auth, CSRF, body-size limit) and all routes, then starts the Gin server.
- **`src/配置.wsv`** — Configuration merge logic: `defaults < YAML file < database settings < environment variables < in-memory overrides`.

---

## Quick Start

### Requirements

- **IDE**: Volcano Windows IDE (火山服务器软件开发平台) — Windows-only, used to open the `.vprj` project and transpile `.wsv` sources into a Go binary. The IDE bundles the Go toolchain, so **no separate Go install is required**.
- **Runtime**: Only the compiled executable is needed at runtime — frontend static assets are embedded in the binary and auto-extracted. No external dependencies.
- **Supported Platforms**: Windows, Linux, macOS, Android (arm64/amd64).

> The Volcano Windows IDE only runs on Windows, so **compilation must happen on Windows**. The produced binary can be cross-compiled for any target platform and copied over to run.

### Get the Source Code

```bash
git clone <your-repo-url> VoldpAiAgent
cd VoldpAiAgent
```

### Open the Project

1. Launch the **Volcano Windows IDE**.
2. Open `VoldpAiAgent.vprj`.
3. The IDE resolves modules from `plugins\vprj_server\classlib\sys\*` (Gin, GORM, crypto, net, FTP, etc.).

### Configuration

Edit one of the following before the first run:

- `config.yaml` (created under the application home directory) — main configuration items.
- `providers.json` — model provider endpoints and keys (or configure providers through the web UI Settings page).
- Environment variables with the `HERMES_` prefix — see [Configuration](#configuration).

At minimum, set a provider API key (e.g. `DEEPSEEK_API_KEY`) and a default model.

### Build & Run (per platform)

#### Windows

1. In the Volcano Windows IDE, click **Compile** (编译) to transpile `.wsv` → `.go` → binary.
2. Run the produced `VoldpAiAgent.exe` (double-click or click **Run** in the IDE). On startup the console prints:

```
[webui] VoldpAiAgent 火山语言版本启动中...
[ok] 配置初始化完成, 端口: 8787
  VoldpAiAgent listening on http://127.0.0.1:8787
  Then open:     http://localhost:8787
```

#### Linux

The Volcano IDE is Windows-only, so first compile any platform in the IDE on Windows to generate the `.go` intermediate files, then cross-compile with the IDE's bundled Go toolchain:

1. In the Volcano IDE on Windows, compile any platform once (e.g. Windows) to generate the `.go` files and `go.mod` under `_int\VoldpAiAgent\release\project`.
2. Cross-compile using the IDE's bundled Go (path like `E:\voldev25\plugins\vprj_server\sdk\GoLang\go1.26.2\bin\go.exe`) from that project directory:

```powershell
$env:GOOS="linux"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
& "E:\voldev25\plugins\vprj_server\sdk\GoLang\go1.26.2\bin\go.exe" build -o VoldpAiAgent_linux_amd64 ".\rg_volcano_app"
```

3. Upload `VoldpAiAgent_linux_amd64` to the Linux server (frontend static assets are embedded in the binary and auto-extracted at runtime — no need to upload `static/` separately).
4. Make it executable and run on Linux:

```bash
chmod +x VoldpAiAgent_linux_amd64
./VoldpAiAgent_linux_amd64
```

> For arm64, set `GOARCH=arm64`. If SQLite cgo is required on Linux, a matching C cross-compiler must be configured.

#### macOS

Same as Linux, just set:

```powershell
$env:GOOS="darwin"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
```

For Apple Silicon set `GOARCH=arm64`. Copy `VoldpAiAgent_darwin_*` to the Mac and run (frontend static assets are embedded, no need to carry `static/` separately):

```bash
chmod +x VoldpAiAgent_darwin_arm64
./VoldpAiAgent_darwin_arm64
```

> If macOS Gatekeeper blocks the first launch, go to **System Settings → Privacy & Security** and click **Open Anyway**, or run `xattr -d com.apple.quarantine VoldpAiAgent_darwin_arm64` in Terminal.

#### Android

Android requires cross-compilation via the [NDK](https://developer.android.com/ndk). The repo provides `build_android.ps1`:

**Prerequisites:**
1. Any platform has been compiled once in the Volcano IDE (to generate the `.go` files under `_int\VoldpAiAgent\release\project`).
2. NDK 27 is installed (default path in the script: `E:\androidSDK\ndk\27.0.12077973`, editable).
3. The IDE's bundled Go is at `E:\voldev25\plugins\vprj_server\sdk\GoLang\go1.26.2`.

**Build:**

```powershell
# Build arm64 (default, most Android devices)
.\build_android.ps1
# Build amd64 (emulators / x86_64 devices)
.\build_android.ps1 -Arch amd64
# Build both architectures
.\build_android.ps1 -Arch both
```

Output goes to `_int\VoldpAiAgent\release\linker\VoldpAiAgent_android_arm64` (API level 30, Android 11+ compatible).

**Deploy to device:**

```bash
# Push to the device via adb and grant execute permission
adb push VoldpAiAgent_android_arm64 /data/local/tmp/
adb shell chmod +x /data/local/tmp/VoldpAiAgent_android_arm64
adb shell /data/local/tmp/VoldpAiAgent_android_arm64
```

> The Android device must have **USB debugging** enabled and be connected via adb. Frontend static assets are embedded in the binary and auto-extracted at runtime — no need to push `static/` separately. After launch, open `http://127.0.0.1:8787` in the device browser, or use `adb forward tcp:8787 tcp:8787` to access it from your computer.

### Access

Open <http://127.0.0.1:8787> in your browser. If a password hash is configured (`HERMES_WEBUI_PASSWORD` or the `password_hash` settings row), you will be prompted to log in.

> If the server listens on `0.0.0.0` (via `HERMES_WEBUI_HOST=0.0.0.0`), other devices on the LAN can access it at `http://<your-IP>:8787`. For production, always configure `HERMES_ALLOWED_ORIGINS` and a password as well.

---

## Configuration

Configuration follows a strict merge chain — later sources override earlier ones:

```
defaults  <  config.yaml  <  database settings table  <  HERMES_ environment variables  <  in-memory overrides
```

### config.yaml

Located at `<HERMES_HOME>/config.yaml` (path overridable via `HERMES_CONFIG_PATH`). Common keys:

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `127.0.0.1` | Listen address |
| `port` | `8787` | HTTP port |
| `model` | _(empty)_ | Default model name |
| `provider` | _(empty)_ | Default provider name |
| `context_length` | `128000` | Context window length |
| `threshold_tokens` | `115200` | Context compaction threshold |
| `max_upload_mb` | `50` | Max upload size in MB |
| `request_timeout` | `300` | General request timeout (seconds) |
| `ai_request_timeout` | `600` | AI request timeout (seconds) |
| `max_iterations` | — | Max agent iterations |
| `log_level` | `info` | Log level |
| `debug` | `false` | Debug mode |
| `cors_origin` | _(empty)_ | Allowed CORS origin |
| `state_dir` | `<HERMES_HOME>/webui` | WebUI state directory |
| `tls_cert` / `tls_key` | _(empty)_ | TLS certificate / key paths |

### Environment Variables

All WebUI environment variables use the `HERMES_` prefix.

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_HOME` | Windows: `%LOCALAPPDATA%\hermes`; other platforms: `~/.hermes` | Application home directory |
| `HERMES_CONFIG_PATH` | `<HERMES_HOME>/config.yaml` | Path to `config.yaml` |
| `HERMES_WEBUI_HOST` | `127.0.0.1` | Listen host |
| `HERMES_WEBUI_PORT` | `8787` | Listen port |
| `HERMES_WEBUI_PASSWORD` | _(empty)_ | Login password (stored as hash) |
| `HERMES_WEBUI_DEFAULT_MODEL` | _(empty)_ | Default model |
| `HERMES_WEBUI_DEFAULT_PROVIDER` | _(empty)_ | Default provider |
| `HERMES_WEBUI_DEFAULT_WORKSPACE` | current directory | Default workspace path |
| `HERMES_WEBUI_STATE_DIR` | `<HERMES_HOME>/webui` | State directory |
| `HERMES_WEBUI_CONTEXT_LENGTH` | `128000` | Context length |
| `HERMES_WEBUI_THRESHOLD_TOKENS` | `115200` | Compaction threshold |
| `HERMES_WEBUI_MAX_UPLOAD_MB` | `50` | Max upload size |
| `HERMES_WEBUI_REQUEST_TIMEOUT` | `300` | Request timeout (s) |
| `HERMES_WEBUI_AI_REQUEST_TIMEOUT` | `600` | AI request timeout (s) |
| `HERMES_WEBUI_MAX_SESSIONS` | `1000` | Max sessions |
| `HERMES_WEBUI_CORS_ORIGIN` | _(empty)_ | CORS origin |
| `HERMES_WEBUI_LOG_LEVEL` | `info` | Log level |
| `HERMES_WEBUI_DEBUG` | _(empty)_ | `true` to enable debug |
| `HERMES_WEBUI_TLS_CERT` | _(empty)_ | TLS cert path |
| `HERMES_WEBUI_TLS_KEY` | _(empty)_ | TLS key path |
| `HERMES_WEBUI_PASSKEY` | _(empty)_ | `true` to enable Passkey |
| `HERMES_WEBUI_ONBOARDING_OPEN` | _(empty)_ | `1` to open onboarding |
| `HERMES_WEBUI_CUSTOM_MODELS_TIMEOUT` | `5` | Custom model endpoint timeout (s) |
| `HERMES_WEBUI_SKILLS_DIR` | `<HERMES_HOME>/skills` | Skills directory |
| `HERMES_WEBUI_PLUGINS_DIR` | `~/.hermes/plugins` | Plugins directory |
| `HERMES_WEBUI_EXTENSION_DIR` | _(empty)_ | Extensions directory |
| `HERMES_WEBUI_RUNNER_BASE_URL` | _(empty)_ | External runner base URL |
| `HERMES_WEBUI_RUNNER_API_KEY` | _(empty)_ | External runner API key |
| `HERMES_WEBUI_CHAT_BACKEND` | _(empty)_ | Chat backend selector |
| `HERMES_WEBUI_GATEWAY_BASE_URL` | _(empty)_ | Gateway base URL |
| `HERMES_WEBUI_GATEWAY_API_KEY` | _(empty)_ | Gateway API key |
| `HERMES_WEBUI_SLOW_REQUEST_SECONDS` | _(empty)_ | Slow-request threshold |
| `HERMES_ALLOWED_ORIGINS` | _(empty)_ | Allowed origins (CORS) |
| `HERMES_KANBAN_TASK_ID` | _(empty)_ | If set, process runs as a kanban worker and exits |
| `HERMES_WEBUI_AUTO_INSTALL` | _(empty)_ | Auto-install flag |
| `HERMES_WEBUI_AGENT_DIR` | _(empty)_ | Agent directory |

Provider API keys are read from conventional variable names, e.g. `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `API_SERVER_KEY`, `TAVILY_API_KEY`.

### Profile System

Each profile owns an independent directory under `<HERMES_HOME>/profiles/<name>/` containing its own `state.db`, sessions and settings. The active profile is stored in `<HERMES_HOME>/active_profile`. The `default` profile maps directly to `<HERMES_HOME>`. Profile names must match `^[a-zA-Z0-9_-]+$`.

### providers.json

`providers.json` is a runtime health snapshot of configured model providers. Each entry reports `provider`, `reachable`, `has_key`, `models_total` and `latency_ms`. Supported built-in providers include:

| Provider | Base URL |
|----------|----------|
| DeepSeek | `https://api.deepseek.com` |
| SiliconFlow (硅基流动) | `https://api.siliconflow.cn/v1` |
| MiMo (Xiaomi) | `https://api.xiaomimimo.com/v1` |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | OpenRouter endpoint |
| ZhipuGLM | `https://open.bigmodel.cn/api/paas/v4` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| custom | Any OpenAI-compatible endpoint |

Provider management (create / update / delete / health check) is also available through the web UI Settings page and the `/api/providers` routes.

---

## Usage Guide

> For the full walkthrough, please refer to **`使用指南.md`** (in Chinese). The summary below covers the main flows.

### 1. AI Chat

- Select a provider and model in the chat view (or set `HERMES_WEBUI_DEFAULT_PROVIDER` / `HERMES_WEBUI_DEFAULT_MODEL`).
- Reasoning models (e.g. GLM-Z1, DeepSeek-R1) emit a separate `reasoning` stream rendered in a dedicated panel.
- Slash commands are available in the input box (see below).

### 2. Kanban Tasks

- Create tasks from the kanban view; status flows `triage → todo → ready → running → done` (with `blocked` / `archived`).
- Auto-dispatch spawns a worker process with `HERMES_KANBAN_TASK_ID=<id>`; the worker loads the task, calls the LLM, writes the result as a comment, and marks the task `done` / `blocked` before exiting.

### 3. Skills

- Drop a skill folder containing `SKILL.md` into `<HERMES_HOME>/skills/`.
- Skills hot-reload; run `/reload-skills` to refresh manually.
- Slash commands such as `/reload-mcp`, `/reload-skills` are defined in `src/命令.wsv`.

### 4. Memory

- Edit `SOUL.md`, `USER.md`, `MEMORY.md` under the memory directory; contents are auto-injected into chat context.
- `save_memory` and `vector_search` tools provide programmatic memory storage and TF-IDF / Embedding retrieval.

### 5. Plugins

- Place plugins under `~/.hermes/plugins/<name>/dashboard/` with a `manifest.json`.
- Each plugin can register a dashboard tab; static assets are served by the plugin manager.

### 6. Cron Tasks

- Create scheduled jobs from the UI; the scheduler ticks every 60 seconds, records run history, and supports manual triggers.

### 7. Workspace

- Open a workspace directory to browse the file tree, preview files and view Artifacts. System paths (`C:\Windows`, `/etc`, etc.) are blocked for safety.

### 8. Terminal & Git

- Use the built-in terminal panel to run shell commands; Git operations are integrated into the workspace view.

---

## Development Notes

### Volcano Windows Development

- Source files use the `.wsv` extension, UTF-8 (no BOM). The project file is `.vprj`, modules are `.vgrp`.
- The Volcano language uses **Chinese keywords** (`类` / `方法` / `如果` / `循环` / `返回`). Classes compile to Go structs, methods to Go functions.
- Embedded Go code is written as inline blocks prefixed with `# @` (file-level) or `@` (statement-level). These blocks are emitted verbatim into the generated `.go` file.
- Only code reachable from `启动方法` (the startup method) is compiled; unreachable code is silently dropped.
- After editing `.wsv` files, recompile in the Volcano IDE — there is no command-line build for `.wsv`.

### .wsv File Format

A typical module starts with:

```
<火山程序 类型 = "通常" 版本 = 1 />

包 火山.程序 <@服务器.导入 = "github.com/gin-gonic/gin" ...>

类 配置管理类 <公开>
{
    变量 端口 <公开 静态 类型 = 整数 值 = 8787>

    方法 启动方法 <公开 类型 = 整数>
    {
        // 火山语言语句
        @ Rg_QiDongFuWuQi(@<引擎>, @<监听地址>)   // 内联 Go 调用
        返回 (0)
    }

    # @ func Rg_Helper() string {        // 文件级 Go 代码块
    # @     return "hello"
    # @ }
}
```

- `# @` lines at the class/file level define raw Go functions (the `Rg_` prefix is the project convention for generated helpers).
- `@` inside a method body inlines Go statements.
- `@嵌入式方法` marks a method whose body is emitted directly as Go code.

### Frontend Static Files

- All frontend assets live in `src/static/` and are served from the binary's executable directory via Gin's `NoRoute` handler.
- The HTML entry is `src/static/index.html`; main scripts include `boot.js`, `ui.js`, `panels.js`, `sessions.js`, `workspace.js`, `terminal.js`, `commands.js`.
- Vendored libraries: `vendor/js-yaml`, `vendor/katex`, `vendor/smd.min.js`.

### Adding a New Route

1. Open `src/路由.wsv` (the route registration module).
2. Register the handler on the Gin engine, e.g.:

```
引擎.注册GET2 ("/api/my-route")
{
    变量 上下文 <参考 类型 = Gin上下文>
    上下文 = Gin路由处理程序接口.取上下文 ()
    上下文.写出JSON (200, Gin哈希表.创建Gin哈希表 ("ok", 真))
}
```

3. Recompile in the Volcano IDE and restart the server.

### Databases

| File | Purpose |
|------|---------|
| `httpServer.db` | Main DB — sessions, settings, providers, cron jobs/history |
| `<HERMES_HOME>/kanban.db` | Kanban tasks and events |
| `<HERMES_HOME>/state.db` | Optional insights state sync |

---

## Roadmap

- Continue migrating IM adapters (Telegram, WhatsApp, WeChat, DingTalk, Feishu) from embedded to native Volcano modules.
- Expand reasoning-model provider coverage and tool-calling compatibility.
- Harden multi-profile isolation and state-sync reliability.
- Improve frontend accessibility and i18n.
- Polish Android terminal & IM adapter support.
- Provide one-shot cross-compile scripts for Linux/macOS.

---

## Contributing

Contributions are welcome. To contribute:

1. Fork the repository and create a feature branch.
2. Make changes in the corresponding `.wsv` module(s); keep the `Rg_` helper naming convention.
3. Recompile in the Volcano Windows IDE and verify the server boots on `http://127.0.0.1:8787`.
4. Open a pull request describing the change, the module(s) touched and how you tested it.

Please keep embedded Go blocks minimal and prefer Volcano language constructs where an equivalent exists.

---

## License

This project is licensed under the **MIT License**. See the `LICENSE` file for details.

---

## Disclaimer

This project is provided for **learning and research purposes only**. It is an independent AI agent platform built with Volcano Windows programming technology and is not affiliated with, endorsed by, or officially connected to any LLM provider. All third-party trademarks and service names are the property of their respective owners.

The authors and contributors assume no responsibility for any direct or indirect losses arising from the use of this software. Users are solely responsible for complying with the terms of service of any AI provider they configure, and for ensuring that their usage respects applicable laws and regulations.
