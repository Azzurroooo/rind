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
  <a href="assets/agents-management.png"><img src="assets/agents-management.png" alt="Rind CLI 的 Agents Management 面板：左侧选择团队，中间展示开发、测试、审查成员及工作状态，右侧查看所选成员的工作区与活动。" width="1200" /></a><br />
  <sub>Rind CLI · Agents Management · 示例团队 · 点击放大</sub>
</p>

**给团队一个目标。看清工作进展。验收最终交付。**

- **轻量，从设计开始。** 共享执行引擎，会话按需加载，历史保存在磁盘。本地运行，无需维护数据库。
- **目录即智能体。** 每位队友都有自己的工作区、文件、指令与技能。已有目录直接加入，也能用 Git worktree 并行开展工作。
- **看得见的多 Agent 协作。** 主 Agent 分工，成员各自推进，结果汇总交回。Agents Management 在一个交互界面中呈现团队、会话与进度。
- **模型，由你选择。** 支持 ChatGPT 账号登录，也能通过 API key 接入 OpenAI、Anthropic、Google、DeepSeek 及其他兼容服务商。

## 开始使用

**CLI：进入项目，直接开聊。**

```bash
npm install -g @rind-ai/cli
cd your-project
rind
```

进入 Rind 后，用 `/login` 连接服务商，用 `/model` 选择模型。使用 ChatGPT 订阅时，选择 **OpenAI → Sign in with an account**，在浏览器中完成登录。可用模型与额度取决于你的账号和订阅。

**Desktop：在图形界面中处理会话、文件与工具结果。** [下载 Windows、macOS 或 Linux 桌面端](https://github.com/Azzurroooo/rind/releases/tag/v0.9.0)。组建与管理多 Agent 团队，请使用下方的 CLI Agents Management。

想先看看？[体验官网交互演示](https://rindai.dev/zh/#tour)，或在 Rind 中打开 `/tour`。内置教学无需 API key。

<details>
<summary>CLI 运行要求、独立下载与源码运行</summary>

npm 安装需要 Node.js 18+，支持 Windows、macOS 和 Linux。独立 CLI 安装包见 [Releases](https://github.com/Azzurroooo/rind/releases)。

源码运行需要 Python 3.12+、Node.js 18+ 与 Git，步骤见[源码运行指南](docs/internals/07-surfaces/interactive-cli.zh-CN.md#从源码运行)。

</details>

## 在界面里，组建你的团队

1. **打开 Agents Management。** CLI 输入框为空时，按 <kbd>←</kbd>。
2. **选择 New team，再 Add member。** 加入已有目录、新建工作区，或创建 Git worktree。为成员分配角色，首位成员成为主 Agent。
3. **选中主 Agent，布置任务。** 按 <kbd>t</kbd>，说清楚你想要的结果。

> 完成登录页。让前端和后端负责实现，测试验证功能，Reviewer 审查改动。把完成的代码和验证结果一起交回来。

也可以打开 **Manager**，直接用自然语言描述你想组建的团队。

**随时参与，随时掌握。** 打开任一成员即可直接交流；在 **Organization** 看团队，在 **Tasks** 看工作，在 **Inbox** 处理提问与交付。**Background** 展示离开终端后仍在继续的工作。报告交回后，由你验收，或提出反馈继续修改。

[了解 Agents Management →](docs/agents-management.zh-CN.md)

## 你的目录，你的团队

一个工作区，就是一位有职责的队友。文件提供上下文，`RIND.md` 保存长期指令，技能沉淀可复用的经验。角色与汇报关系由你安排，目录可以留在原来的位置。

**开发团队、投研小组、个人助理。** 结构由你定义。从一个 Agent 开始，随工作需要加入更多专家。

## 更多工作方式

- **接着上次继续。** 会话历史持久保存，回来就能继续推进。
- **从更多地方连接。** 支持 [Web 与移动端](docs/internals/07-surfaces/web-and-mobile.zh-CN.md)，以及 [Telegram、Discord、Slack、飞书](docs/internals/07-surfaces/gateway.zh-CN.md)。
- **需要时，再自动化。** 用 `rind run` 接入脚本与 CI，用 `rind send` 给运行中的会话补充指令。团队管理也提供命令行接口。

<details>
<summary>开发者：扩展 Rind，或复用其中的模块</summary>

Rind 将执行引擎与交互界面分开。你可以基于 [Runtime 协议](agent/runtime/server/protocol.py) 构建新客户端，添加[工具](agent/infrastructure/tools/spec.py)，或复用独立的 [Agents Management 服务](agent-management)。

进一步阅读[内部原理](docs/README.zh-CN.md)、[系统地图](docs/internals/00-architecture/system-map.zh-CN.md)与[开发指南](docs/internals/08-engineering/verification.zh-CN.md)。

</details>

## 参与贡献

欢迎贡献代码与提交 [issue](https://github.com/Azzurroooo/rind/issues)。详见[贡献指南](CONTRIBUTING.md)。

[MIT 许可证](LICENSE)
