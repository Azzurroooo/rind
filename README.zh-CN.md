<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="104" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  一个精巧、标准、可恢复的 Python Agent 运行时，面向真实的本地编码工作流。
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12+-blue.svg" alt="Python 3.12+" />
  <img src="https://img.shields.io/badge/Architecture-layered-success.svg" alt="Layered architecture" />
  <img src="https://img.shields.io/badge/Surfaces-CLI%20%2B%20Desktop-informational.svg" alt="CLI 与 Desktop 界面" />
</p>

## Rind 是什么？

Rind 是一个轻量编码 Agent，提供 Node.js 前端 CLI 和 Electron Desktop 两个产品界面。二者共享同一套 Python Runtime Package；该实现也可作为理解紧凑 Agent 运行时的参考样本。

这个项目的基本判断是：Agent 不必先成为庞大的框架，才能成为可靠的工具。Rind 尽量保持结构清楚、工具契约克制、运行状态可追踪。从上下文压缩到工具执行，每个部件都以尽可能小的形式实现，同时不牺牲交互体验和工程可维护性。

## 设计理念

- **先做减法，再做加法**：优先减少概念、模块和隐式状态。只有当抽象确实降低复杂度时，才引入新的抽象。
- **小工具，清晰契约**：Shell、文件、网页、计划和技能等工具都通过紧凑接口暴露，返回结构尽量稳定可预测。
- **把上下文当作运行时状态**：上下文估算、自动压缩和工具结果归一化不是提示词附属品，而是运行时的核心职责。
- **本地优先，可持续恢复**：会话、消息、工具调用、压缩记录和元数据都以 append-only 的本地记录保存，便于中断后继续工作。
- **标准 Python，而非框架惯性**：项目使用普通 Python 模块、依赖倒置、异步编排和聚焦的服务层，避免把简单问题包裹进过重的框架。
- **默认好用，机制可见**：两个界面都在需要时展示模型、会话、工作目录、状态和诊断信息。

## 能力概览

- 前端 CLI 和 Desktop 界面，支持流式输出、斜杠命令、会话恢复、状态渲染和本地诊断。
- 会话可观测性：`/usage` 查看 token 用量与累计，`/context` 查看上下文构成占比，`/fork` 携带完整历史分支会话。
- OpenAI 兼容的异步 Chat Client，支持配置模型、base URL 和 reasoning effort。
- 基于 JSONL 的 append-only 会话存储，记录消息、工具调用、压缩结果和会话元数据。
- 运行时上下文管理，包含预算估算、自动压缩、上下文长度救援和工具结果归一化。
- 轻量的 session-local `update_plan` 工具，用于跨轮次追踪多步骤任务。
- 内置 Shell、文件、网页、计划和技能发现等工具。
- 唯一的无头 JSONL Runtime Server 为两个界面服务；Python 不再提供交互式 CLI。

## 快速开始

### 环境要求

- Python 3.12+
- 一个 OpenAI 兼容 Chat Completion 端点的 API Key

### 安装

```bash
git clone https://github.com/Azzurroooo/rind.git
cd rind

python -m venv .venv
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements-runtime.txt
```

macOS 或 Linux:

```bash
source .venv/bin/activate
pip install -r requirements-runtime.txt
```

### 配置

Rind 的 API 配置只读取 `~/.rind/settings.json`，Desktop 与 CLI 使用同一个文件。`RIND_HOME` 仍可控制 session 等运行数据，但不会影响 API 配置。

最小 `settings.json` 示例：

```json
{
  "model": "your-model-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "reasoningEffort": "high"
}
```

### 运行

#### 一键部署 Web

安装 Docker Desktop 或 Docker Engine（含 Compose v2）后，在仓库根目录执行：

```bash
export RIND_SERVER_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(24))')"
docker compose up -d --build
```

然后打开 `http://localhost:8080`，使用 `RIND_SERVER_TOKEN` 登录。该命令会构建生产版 Web 前端，并在同一套 Compose 服务中启动长期运行的 WebSocket worker。worker 的 WebSocket 端点通过一次性 ticket（浏览器）或常驻 token（脚本）鉴权——非 loopback 绑定且无 token 时拒绝启动。当前目录挂载为工作目录，`./.rind` 用于保存配置和会话。停止服务：

```bash
docker compose down
```

可以在 `.env` 中覆盖默认路径和端口：

```dotenv
RIND_WORKSPACE=/absolute/path/to/workspace
RIND_HOME=/absolute/path/to/rind-data
RIND_WEB_PORT=8080
RIND_WEB_BIND=127.0.0.1
RIND_SERVER_TOKEN=change-me
RIND_PYPI_INDEX_URL=https://pypi.org/simple
RIND_DEBIAN_MIRROR=deb.debian.org
```

只有在主机已配置认证和 TLS 时，才将 `RIND_WEB_BIND` 改为 `0.0.0.0`——参见下方「远程访问」。

浏览器断开只关闭 WebSocket 连接；worker 进程与会话执行继续运行。重连后 Web 端通过增量回放追平错过的 durable 事件，中途合盖休眠的笔记本重新打开即可接上完整历史。

#### 远程访问

Rind 刻意保持攻击面很小：一个 WebSocket 端点、一个 token、没有第二套 REST API。从其他机器访问 worker：

- **推荐：私有网络。** 在 worker 主机与你的设备上都运行 Tailscale（或 WireGuard），浏览器直接指向 tailnet 地址——不向公网暴露端口。
- **隧道：** `cloudflared tunnel --url http://localhost:8080` 为 Web 界面加 TLS 前置；务必保持 `RIND_SERVER_TOKEN` 已设置。
- 不要在没有 TLS 的情况下直接转发 worker 端口（8765）；token 随握手查询串传输。

#### 消息网关（Telegram、Discord 等）

可选的网关进程把 IM 渠道接入同一个 worker——一条连接订阅所有渠道会话，对话上下文跨设备延续：

```bash
python main.py gateway --config .rind/gateway.yaml
```

```yaml
worker: ws://127.0.0.1:8765
worker_token: ${RIND_SERVER_TOKEN}
workspace: /workspace
channels:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    allow_from: ["12345678"]
  discord:
    token: ${DISCORD_BOT_TOKEN}
pairing:
  enabled: true
```

- `${VAR}` 从环境变量插值；未知键与未定义变量都是启动错误，绝不静默兜底。
- 渠道 SDK 是按渠道可选的依赖（`requirements-gateway.txt`），仅在对应渠道启用时才 import。
- 陌生发送者会收到一次性配对码；在服务端执行 `python main.py gateway approve <CODE>` 完成批准。
- Docker 部署中网关是 opt-in 服务：`docker compose --profile gateway up -d`，配置放在 `./.rind/gateway.yaml`。它只发起出站连接——没有任何入站端口。

Node 前端 CLI：

```bash
node frontend-cli/bin/rind.js
```

Desktop 应用：

```bash
npm --prefix desktop run dev
```

Python 入口是两个界面共用的无头 Runtime Package：

```bash
python main.py app-server --stdio --cwd .
```

Runtime Package 通过统一 JSONL 协议服务两个界面，会话、模型、goal、后台任务、slash command 和 turn 控制都由该协议处理，Python 不再提供独立交互 UI。

项目级 `RIND.md` 和项目级 skills 以启动 Rind 时的当前工作目录为根目录。

## 架构

Rind 使用分层结构，并在运行时核心与基础设施适配器之间遵循依赖倒置。

```text
agent/
├── runtime/
│   ├── core/          # Agent runtime、turn runner、流解析与泵送
│   └── server/        # JSONL server facade、协议与 runtime commands
├── application/
│   ├── context/       # 上下文管理、估算、压缩和 token 使用
│   ├── tools/         # 工具执行、处理、保护策略和结果归一化
│   └── ports/         # Chat client、会话存储、工具注册表抽象
├── domain/            # 事件、取消、规划和工具契约
├── infrastructure/
│   ├── llm/           # OpenAI 兼容异步 Chat Client
│   ├── persistence/   # append-only 会话记录与仓储
│   ├── planning/      # session-local 计划存储和 compact 快照
│   └── tools/builtin/ # ToolSpec 实现与 build_builtin_tool_specs catalog
frontend-cli/          # Node.js 终端 Surface
desktop/               # Electron Desktop Surface
```

运行时与持久化边界见 [`docs/architecture.md`](docs/architecture.md)。

## 开发

安装开发依赖：

```bash
pip install -r requirements.txt
```

运行测试：

```bash
pytest test/ -q
```

测试覆盖运行时事件、上下文预算、压缩、会话持久化、恢复行为、工具结果归一化、计划、技能、协议处理和 Surface 渲染。

## 展望

Rind 关注的是：在保持足够简单、可读、可测试的前提下，Agent 系统还能走多远。后续探索会围绕三个方向展开：

- 如何让 Agent 的能力增长不必伴随过多机制膨胀。
- 如何探索 Agent 的全新呈现方式，让工作过程更可观察、更连续、更平静。
- 如何为 Python Agent 的通用设计提供更清楚的结构、边界和实现路径。

这个项目在形态上保持克制，但目标并不保守：它希望证明，一个有能力的 Agent 可以由简单部件、可见状态和清晰边界组成。

## 许可证

本项目基于 [MIT License](LICENSE) 发布。
