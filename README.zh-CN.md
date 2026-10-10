<p align="center">
  <img src="assets/rind.svg" alt="Rind 标志" width="100" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  <strong>轻装上阵。目录即智能体。</strong><br />
  轻量、开源的编码 Agent。在本地工作，让团队协作。
</p>

<p align="center">
  <a href="https://rindai.dev/zh/">官网与演示</a> · <a href="https://rindai.dev/zh/docs/">文档</a> · <a href="README.md">English</a> | 简体中文
</p>

<p align="center">
  <a href="https://github.com/Azzurroooo/rind/releases"><img src="https://img.shields.io/github/v/release/Azzurroooo/rind?label=release" alt="最新版本" /></a>
  <a href="https://www.npmjs.com/package/@rind-ai/cli"><img src="https://img.shields.io/npm/v/@rind-ai/cli" alt="npm 包" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证" /></a>
</p>

<p align="center">
  <a href="assets/rind-cli-demo.mp4"><img src="assets/rind-cli-demo.gif" alt="15 秒 Rind CLI 演示：读取代码，询问测试范围，接收用户选择，修改测试，运行测试并汇报结果。" width="1200" /></a><br />
  <sub>读代码，问清楚，改文件，跑测试，交结果。· 15 秒模拟 CLI 会话 · <a href="assets/rind-cli-demo.mp4">观看视频</a></sub>
</p>

**给团队一个目标。看清工作进展。验收最终交付。**

小改动，交给一个 Agent。大目标，交给一个团队。工作留在你的目录里，工具过程看得见，你始终可以参与其中。

## Team Agents Management · 多智能体协作

### 目录即智能体。每个目录，都是一位队友。

**把工作区加入团队，让每个 Agent 在自己的目录里工作。**

工作区，是 Agent 的工作现场：文件提供上下文，`RIND.md` 定义长期指令，技能沉淀可复用的经验。赋予职责，接入团队，让不同专长并行推进。已有目录可以留在原处；需要独立代码副本时，也能用 Git worktree 分开工作。

<p align="center">
  <a href="assets/agents-management.png"><img src="assets/agents-management.png" alt="Rind CLI 的 Agents Management 面板：左侧选择团队，中间展示开发、测试、审查成员及工作状态，右侧查看所选成员的工作区与活动。" width="1200" /></a><br />
  <sub>Rind CLI · Agents Management · 示例团队 · 点击放大</sub>
</p>

- **一个目标，各尽所长。** 主 Agent 分工，成员实现、测试、审查，结果逐级汇总，由主 Agent 检查后交付给你。
- **协作，不是黑箱。** Organization 呈现团队与汇报关系，Tasks 跟踪工作，Inbox 汇集提问与交付，Background 展示持续运行的工作。
- **结构，由你定义。** 开发团队、投研小组、个人助理网络。职责、目录与汇报关系，都按你的工作方式组织。

目录是 Agent 的家，会话是它的一段工作。加入团队，不意味着每位成员都要常驻一套执行引擎。

[了解 Agents Management →](docs/agents-management.zh-CN.md)

## 轻量，从设计开始。按需工作。

**留下工作，卸下负担。**

Rind 将长期上下文与临时执行分开：会话历史保存在磁盘文件中，不只存在于一个常驻 Agent 的内存里。有工作时，共享 Worker 组装执行上下文；一轮工作结束、没有待处理输入时，释放执行容器与模型客户端。下一轮，从保存的上下文重新加载。

- **共享基础设施，独立工作现场。** 会话复用 Worker 服务，不为每段保存的对话常驻一个执行容器。
- **执行可释放，历史不丢失。** 回来就能接着聊，无需让旧执行对象一直占着内存，也无需维护数据库服务。
- **后台工作，有自己的生命周期。** 托管的 Shell 进程可以在一轮执行释放后继续运行，输出、状态与取消仍由 Worker 管理。

这里的「无状态」指持久会话上下文可从磁盘恢复，**不是 Worker 完全没有运行状态**。活跃进程、队列与取消都有明确归属。低负载来自**需要时加载，空闲时释放**，而不是丢掉你的历史。

[了解轻量 Worker 内核 →](docs/internals/01-runtime/resource-ownership.zh-CN.md)

## 一个内核，多种入口。

**桌前、浏览器里、手机上。工作始终在你的主机。**

<p align="center">
  <a href="assets/rind-clients.png"><img src="assets/rind-clients.png" alt="Rind 三端示例拼图：带项目侧栏的 Desktop、浏览器中的 Web，以及连接电脑的移动 App。使用真实客户端渲染器展示示例编码会话。" width="1200" /></a><br />
  <sub>Desktop · Web · App · 真实客户端渲染，示例数据 · 点击放大</sub>
</p>

- **Desktop：** 本地图形工作台，集中处理会话、项目文件与工具结果。[下载 v0.9.0：Windows / macOS / Linux](https://github.com/Azzurroooo/rind/releases/tag/v0.9.0)。
- **Web：** 通过 Desktop 远程访问，在浏览器里连接工作区；也能搭配独立 Worker 自托管。[Web 部署指南 →](docs/internals/07-surfaces/web-and-mobile.zh-CN.md)
- **App：** 在手机上继续主机里的会话。移动端连接电脑或服务器，模型、工具与文件仍在主机上执行与保存。[Android / iOS 源码与构建指南 →](mobile/README.md)

多端共享执行内核，**并不代表功能完全一致**。目前 **Team Agents Management 在 CLI 0.10.0 中提供**。移动端是远程客户端，不是在手机上运行编码内核；原生构建需要对应平台工具链。

## 模型，由你选择。

**接入 ChatGPT 订阅，也支持自备 API key。**

Rind 支持 OpenAI 账号登录，以及 OpenAI、Anthropic、Google、DeepSeek 等服务商的 API key 接入。按工作选择模型，继续使用 Rind 的工具与本地工作区。订阅可用模型与额度取决于你的账号和方案。

## 开始使用

### 安装 CLI

**进入项目，直接开聊。**

需要 Node.js 18+，支持 Windows、macOS 与 Linux。

```bash
npm install -g @rind-ai/cli
cd your-project
rind
```

进入 Rind 后，用 `/login` 连接服务商，用 `/model` 选择模型。使用 ChatGPT 订阅时，选择 **OpenAI → Sign in with an account**，在浏览器中完成登录。可用模型与额度取决于你的账号和订阅。

想先看看？[体验官网交互演示](https://rindai.dev/zh/#tour)，或在 Rind 中打开 `/tour`。内置教学无需 API key。

### 独立安装包

更喜欢独立安装包？从 [Releases 下载 CLI 0.10.0](https://github.com/Azzurroooo/rind/releases/tag/v0.10.0)。Desktop 0.9.0 下载入口见上方多端章节。

### 从源码启动

需要 Python 3.12+、Node.js 18+ 与 Git。先克隆仓库，创建 Python 虚拟环境：

```bash
git clone https://github.com/Azzurroooo/rind.git
cd rind
python -m venv .venv
```

macOS / Linux 用 `source .venv/bin/activate` 激活环境，Windows PowerShell 用 `.\.venv\Scripts\Activate.ps1`。然后安装运行依赖，构建 Agents Management，并启动 CLI：

```bash
python -m pip install -r requirements-runtime.txt
npm install --prefix agent-management
npm run build --prefix agent-management
npm install --prefix frontend-cli
node frontend-cli/bin/rind.js
```

要在其他项目中工作，进入该项目目录，再用绝对路径执行 `node /absolute/path/to/rind/frontend-cli/bin/rind.js`。[源码启动与配置指南 →](docs/internals/07-surfaces/interactive-cli.zh-CN.md#从源码运行)

## 更多工作方式

### 把 Rind 带进你的沟通渠道

通过 **Telegram、Discord、Slack 或飞书** 与 Agent 交流。Gateway 将沟通渠道接入同一套主机执行内核。[Gateway 配置指南 →](docs/internals/07-surfaces/gateway.zh-CN.md)

### 接入脚本与 CI

用 `rind run` 完成非交互任务。最终回答写入 stdout，进度与诊断写入 stderr，结果可直接进入你的流水线：

```bash
rind run --prompt "Review the current diff and identify actionable issues." > review.md
```

用 `rind send` 从另一终端给正在运行的会话补充指令。除交互界面外，团队管理也提供命令行 API。

### 扩展 Rind，复用它的能力

Rind 将执行引擎与交互界面分开。你可以基于 [Runtime 协议](agent/runtime/server/protocol.py) 构建新客户端，添加[工具](agent/infrastructure/tools/spec.py)，或复用独立的 [Agents Management 服务](agent-management)。

进一步阅读[内部原理](docs/README.zh-CN.md)、[系统地图](docs/internals/00-architecture/system-map.zh-CN.md)与[开发指南](docs/internals/08-engineering/verification.zh-CN.md)。

## 参与贡献

欢迎贡献代码与提交 [issue](https://github.com/Azzurroooo/rind/issues)。详见[贡献指南](CONTRIBUTING.md)。

[MIT 许可证](LICENSE)
