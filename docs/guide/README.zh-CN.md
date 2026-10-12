# 在 Rind 里干活：按场景查的 CLI 指南

English | [简体中文](README.zh-CN.md)

这套文档不讲架构，只讲**怎么用 CLI 把事做完**。每篇对应一个真实场景：从"我想……"出发，而不是从某个功能出发。

架构与实现细节在 [internals](../internals/README.zh-CN.md)；这里是上手与日常使用。

## 选一个场景

| 你想做什么 | 读这篇 |
| --- | --- |
| 刚装好，想看它跑完一个任务 | [第一次把任务跑完](first-task.zh-CN.md) |
| 任务进行到一半，想改方向、排队或打断 | [干到一半，把活掰回正轨](steer-the-work.zh-CN.md) |
| 接一个模型，或在多个模型间切换 | [让 Rind 用上你指定的模型](models.zh-CN.md) |
| 命令一时跑不完，想让它在后台继续 | [让跑不完的命令自己继续](background.zh-CN.md) |
| 上次没干完，回来接着干 | [回来继续干](resume.zh-CN.md) |
| 把项目背景、 Skills 固定下来 | [把项目装进 Rind](project-context.zh-CN.md) |
| 一个人干不过来，派给一个团队 | [把工作派给一个团队](teams.zh-CN.md) |
| 不坐在终端前，让脚本调遣 Rind | [不进场也能用 Rind](automation.zh-CN.md) |
| 忘了某个键或命令 | [快捷键与命令速查](cheatsheet.zh-CN.md) |

## 三分钟建立直觉

1. **启动**：`rind` 在项目目录下运行，会话第一条消息才创建。
2. **对话**：Enter 发送；回合进行中 Enter 是 steering，Tab 排队。
3. **打断**：Ctrl+C 中断当前回合；Ctrl+O 展开工具输出看细节。
4. **模型**：`/login` 接供应商，`/model` 选模型，Ctrl+T 切推理强度。
5. **后台**：控制台工具超过等待窗口会自动转入后台，Ctrl+B 看进度。
6. **脚本**：`rind run --prompt "..."` 拿最终答案，`rind send --session <id> "..."` 注入正在跑的会话。

## 其他入口

CLI 只是 Rind 的一个 Surface，同一个内核还有：

- **Desktop**：可视化管理多个项目，[架构说明](../internals/07-surfaces/desktop.zh-CN.md)。
- **Web / Mobile**：浏览器或手机连接常驻 Worker，[架构说明](../internals/07-surfaces/web-and-mobile.zh-CN.md)。
- **消息网关**：Telegram、Discord、Slack、飞书等渠道，[架构说明](../internals/07-surfaces/gateway.zh-CN.md)。

[返回文档入口](../README.zh-CN.md)
