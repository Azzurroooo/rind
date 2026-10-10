<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="100" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  <strong>Light by design. Folders are agents.</strong><br />
  A lightweight, open-source coding agent. Work locally. Build with a team.
</p>

<p align="center">
  <a href="https://rindai.dev/">Website & demos</a> · <a href="https://rindai.dev/docs/">Docs</a> · English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Azzurroooo/rind/releases"><img src="https://img.shields.io/github/v/release/Azzurroooo/rind?label=release" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/@rind-ai/cli"><img src="https://img.shields.io/npm/v/@rind-ai/cli" alt="npm package" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="assets/agents-management.png"><img src="assets/agents-management.png" alt="Rind CLI Agents Management: team navigation on the left, a live organization tree with development, testing and review in the center, and the selected member's workspace and activity on the right." width="1200" /></a><br />
  <sub>Rind CLI · Agents Management · example team · click to enlarge</sub>
</p>

**Give your team a goal. Follow the work. Review the delivery.**

- **Light by design.** A shared worker, sessions loaded on demand, history saved on disk. Your agent runs locally without a database to manage.
- **Folders are agents.** Each teammate works in its own workspace, with its own files, instructions and skills. Bring existing folders or create Git worktrees for parallel work.
- **Multi-agent collaboration you can see.** The lead delegates, specialists work, and reports return for review. Agents Management brings the team, conversations and progress into one interactive view.
- **Your models, your choice.** Sign in with your ChatGPT account, or connect OpenAI, Anthropic, Google, DeepSeek and other compatible providers with API keys.

## Get started

**CLI — open your project and start a conversation.**

```bash
npm install -g @rind-ai/cli
cd your-project
rind
```

Inside Rind, use `/login` to connect a provider and `/model` to choose a model. For a ChatGPT subscription, choose **OpenAI → Sign in with an account** and complete the browser sign-in. Available models and usage depend on your account and plan.

**Desktop — a visual workspace for your conversations, files and tool results.** [Download for Windows, macOS or Linux](https://github.com/Azzurroooo/rind/releases/tag/v0.9.0). For team setup and coordination, use the CLI's Agents Management below.

Want a quick look first? [Explore the interactive demos](https://rindai.dev/#tour), or open `/tour` inside Rind. The built-in tour needs no API key.

<details>
<summary>CLI requirements, standalone downloads and source setup</summary>

The npm CLI requires Node.js 18+ and supports Windows, macOS and Linux. Standalone CLI packages are available on [Releases](https://github.com/Azzurroooo/rind/releases).

To run from source, install Python 3.12+, Node.js 18+ and Git, then follow the [source setup guide](docs/internals/07-surfaces/interactive-cli.md#running-from-source).

</details>

## Build your team in the interface

1. **Open Agents Management.** With the CLI input empty, press <kbd>←</kbd>.
2. **Choose New team, then Add member.** Pick an existing folder, a fresh workspace or a Git worktree. Give each member a role; the first member becomes the lead.
3. **Select the lead and assign a task.** Press <kbd>t</kbd> and describe the result you want.

> Ship the login page. Have Frontend and Backend implement it, QA verify it, and Reviewer check the changes. Bring back the finished work and verification results.

You can also open **Manager** and describe the team you want in plain language.

**Stay in the conversation.** Open any member to talk directly. Follow the team in **Organization**, inspect work in **Tasks**, and handle questions and deliveries in **Inbox**. **Background** shows work that keeps running after you leave the terminal. Review the returned report, accept it, or request another pass.

[Explore Agents Management →](docs/agents-management.md)

## Your folders. Your team.

A teammate is a workspace with a job to do. Its files provide context, `RIND.md` gives standing instructions, and skills provide reusable expertise. You choose the roles and reporting relationships; your folders can stay where they are.

**Development team. Research desk. Personal assistant.** The structure is yours. Start with one agent and add specialists as the work grows.

## More ways to work

- **Continue where you left off.** Persistent conversations keep the work available across sessions.
- **Reach your workspace from more places.** [Web and mobile](docs/internals/07-surfaces/web-and-mobile.md), plus [Telegram, Discord, Slack and Feishu](docs/internals/07-surfaces/gateway.md).
- **Automate when it helps.** Use `rind run` for scripts and CI, or `rind send` to steer a running conversation. Team management also has a command-line API.

<details>
<summary>For developers: extend Rind or reuse its parts</summary>

Rind separates the runtime from its interfaces. Build another client on the [runtime protocol](agent/runtime/server/protocol.py), add a [tool](agent/infrastructure/tools/spec.py), or reuse the standalone [Agents Management service](agent-management).

Explore the [internals](docs/README.md), [system map](docs/internals/00-architecture/system-map.md) and [development guide](docs/internals/08-engineering/verification.md).

</details>

## Contributing

Contributions and [issues](https://github.com/Azzurroooo/rind/issues) are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

[MIT License](LICENSE)
