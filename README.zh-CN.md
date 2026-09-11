<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="118" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  <strong>一个天生轻量的本地编码 Agent——可无人值守、可委派小队、可深度扩展、随处可达。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

<p align="center">
  <a href="https://github.com/Azzurroooo/rind/releases"><img src="https://img.shields.io/github/v/release/Azzurroooo/rind?label=release&color=DF7A3A" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Python-3.12%2B-3776AB" alt="Python 3.12+" />
  <img src="https://img.shields.io/badge/Node-18%2B-3C873A" alt="Node 18+" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A085" alt="MIT license" /></a>
</p>

<p align="center">
  <img src="assets/rind-architecture.svg" alt="Rind 将交互、自动化、任务分派与自定义客户端接入同一个本地引擎" width="960" />
</p>

## Rind 的不同之处

四个决定，划定了 Rind 能为你做什么：

### 把任务交出去，然后走人

```bash
rind run --prompt "总结 src/ 里的改动" --dir /workspace/project
```

One-shot 模式是同一个 Agent 的无头形态：最终回答走 `stdout`，过程走 `stderr`，完整运行日志落到 `logs/` 下的 markdown，`--session <id>` 续接早前任务。提问默认关闭，自动化不会被卡死；长命令转后台、会话继续干活，**Ctrl+B** 随时查看后台任务与子代理的实时监视器。

> 钩子、定时任务、流水线拿到的是一个契约干净的 Agent。

### 一支"带状态"的专家小队

传统子代理即用即丢：提示词进去、摘要出来、记忆清零。Rind 的 Team 是文件系统原生且持久的——每个被委派的代理都是一等公民会话，**拥有自己的 workspace 目录、独立的工具集与工作区策略、持续累积的会话历史**（`.aiteam/agents/<name>/`）。专家创建一次（`/team init`、`/team blueprint`、`/team add`），之后的每个任务都从它已知、已写过的东西开始，成果以真实文件发布回来。

> 专家在积累经验，而不是每个任务都从零开始。

### 无状态的轻量内核

worker 不驻留重型状态：agent 容器只在 turn 运行期间存在，结束即释放。所有持久内容——消息、工具调用、压缩记录、用量——都以 append-only JSONL 落在磁盘上。磁盘即真相，内存只做协调：崩溃不丢任何东西，常驻进程永远和新启动时一样轻。

> 小 footprint、即时恢复、没有藏在内存里的状态。

### 一个引擎，四扇门

**CLI** 键盘流终端工作 · **Desktop** 可视化多项目总览 · **Web** 单一 WebSocket（浏览器中途合盖，重连即增量追平）· **IM 网关** 接入 Telegram / Discord。同一批会话、同一套协议、同一个引擎——门换了，工作不换。

> 会话跟着你跨界面，而不是被锁死在一扇门里。

**再补一个 `rind send`**：从任意终端或脚本把提示词投进正在运行的会话——`rind send --session <id> "…"`，空闲会话立即开 turn，忙碌会话自动转为转向；session id 就是地址。

### 常规能力也做扎实了

turn 运行中转向与排队后续 · 任意历史消息处分叉会话（`/fork`）· 实时上下文计量（`/context`，全部实测、估算带 `~` 标记）· append-only JSONL 会话（崩溃安全、可回放、`RIND_HOME` 隔离）· 运行中 turn 崩溃恢复 · 项目文档（`RIND.md`）自动注入上下文 · 技能与计划 · 四套 TTY 主题，流式 Markdown/表格渲染、CJK 宽度正确 · `/doctor` 直接告诉你哪里坏了。

## 快速开始

**安装**（三选一）：

```bash
# 1. GitHub Releases 下载预构建安装器（Windows/macOS/Linux）
# 2. npm：
npm install -g @rind-ai/cli
# 3. 源码：
git clone https://github.com/Azzurroooo/rind.git && cd rind
python -m venv .venv && . .venv/bin/activate   # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
```

**配置**——工作区里完整的 `.rind/settings.json`，缺省回退 `~/.rind/settings.json`：

```json
{
  "model": "your-model-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "reasoningEffort": "high"
}
```

任意 OpenAI 兼容端点都可用。然后：

```bash
rind                          # 交互式 CLI
rind --session <id>           # 打开指定会话
```

## 四张面孔，一个引擎

| 界面 | 适用场景 | 启动方式 |
| --- | --- | --- |
| **CLI** | 键盘流结对、终端工作流 | `rind` |
| **Desktop** | 可视化多项目总览 | `npm --prefix desktop run dev`（源码） |
| **Web** | 浏览器访问、远程机器、共享主机 | `docker compose up -d --build` → `http://localhost:8080` |
| **IM 网关** | 用 Telegram / Discord 当前端 | `python main.py gateway --config .rind/gateway.yaml` |

Web 界面背后是常驻 WebSocket worker：浏览器中途断开，重连后通过增量回放追平错过的 durable 事件——合盖走人，回来接着看。一个端点、一个 token、没有第二套 REST API。远程访问优先走私网（Tailscale/WireGuard）或 TLS 隧道（`cloudflared tunnel --url http://localhost:8080`）；切勿在无 TLS 时直接暴露 worker 端口。通过 `.env` 调整：

```dotenv
RIND_WORKSPACE=/absolute/path/to/workspace
RIND_HOME=/absolute/path/to/rind-data
RIND_WEB_PORT=8080
RIND_WEB_BIND=127.0.0.1
RIND_SERVER_TOKEN=change-me
```

网关只发出站连接；`${VAR}` 从环境变量插值，未知键一律启动报错、绝不静默兜底；陌生发送者走一次性配对码（`python main.py gateway approve <CODE>`）。Docker 下按需启用：`docker compose --profile gateway up -d`。

## 引擎之内

```text
CLI / Desktop / Web / IM / 你的应用
          |
          |  JSONL 请求 + session/update 事件
          v
      Rind Worker
          |
          +-- turn、转向与取消
          +-- 模型适配（OpenAI 兼容）
          +-- 工具与工作区
          +-- 上下文管理与压缩
          +-- append-only 会话记录（JSONL）
```

三个决定撑起这个形态：

- **一个 worker，任意客户端。** 会话标识工作，turn 圈定执行，每个事件都带会话/turn 身份和持久级别。新界面只需说同一套协议，而不是重写 turn 循环。
- **磁盘即真相。** 会话是 `~/.rind`（或 `RIND_HOME`）下纯 append-only 的 JSONL。进程崩溃不丢任何东西；运行中的 turn 有快照可续；历史回放精确。
- **小内核。** 模型客户端、会话存储、工具注册表、上下文管理、turn 调度、取消——一短串可替换的端口，你的代码与 Agent 循环之间没有框架图谱。

**给造轮子的人**，扩展点直接对应源码：

| 想替换/新增 | 起点 |
| --- | --- |
| 模型供应商 | `ChatClient` 及其工厂 |
| 模型可用的能力 | `ToolSpec` 与 `ToolRegistry` |
| 存储后端 | `SessionStore` |
| 上下文策略 | Context 与压缩服务 |
| 人用命令 | Worker 命令注册表或 Surface 命令 |
| 新界面 | JSONL 协议与 `session/update` |

## CLI 速查

| 按键 | 含义 |
| --- | --- |
| **Enter** | 发送——turn 运行中即为转向 |
| **Tab** | 排队后续 · **Alt+↑/↓** 召回排队/转向文本 · **Alt+→** 把后续提升为转向 |
| **Ctrl+B** | 后台任务监视器 · **Ctrl+O** 展开工具输出 · **?** 快捷键表 |
| **Ctrl+C** | 中断 turn / 退出 |

| 命令 | 含义 |
| --- | --- |
| `/context` | 上下文构成 + 用量面板（真实 token） |
| `/fork` `/sessions` `/compact` | 分叉、切换、释放上下文 |
| `/model` `/effort` `/theme` | 选模型、推理力度、配色主题 |
| `/goal` `/skill` `/team` `/doctor` `/help` | 自主目标、技能、小队、诊断、命令表 |

| 入口 | 含义 |
| --- | --- |
| `rind` / `rind --session <id>` | 交互式 |
| `rind run --prompt "…" [--session <id>]` | 无头执行，可接管道 |
| `rind send --session <id> "…"` | 投递到正在运行的会话 |

## 文档与开发

[架构](docs/architecture.md) · [CLI 渲染](docs/cli-rendering.md) · [CLI turn 流程](docs/cli-turn-flow.md) · [主流水线](docs/main_pipeline.md)（英文）

```bash
pip install -r requirements.txt && pytest test/ -q   # 运行时
cd frontend-cli && npm install && npm test           # CLI
```

## 许可证

[MIT](LICENSE)
