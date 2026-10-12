# 让 Rind 用上你指定的模型

English | [简体中文](models.zh-CN.md)

目标：接上供应商、选中模型、按项目固化默认值，并知道在哪里查当前状态。

## 第一次连接

```text
/login
```

菜单覆盖三类来源：

| 来源 | 适合 | 说明 |
| --- | --- | --- |
| 供应商列表 + API Key | OpenAI、Anthropic、Google、DeepSeek 等 | 密钥保存在本地凭证库，不写进仓库 |
| ChatGPT 订阅登录 | 已有 ChatGPT 订阅 | 浏览器授权，复用订阅额度 |
| 命名 endpoint | 自建或第三方 OpenAI 兼容服务 | 起一个名字，之后按名字选用，密钥与地址一起管理 |

`/logout [provider]` 移除已存凭证。

## 选模型与推理强度

- `/model`（裸命令）打开选择菜单；`/model set <model>` 直接指定。
- `/effort` 查看或设置推理强度：`low | medium | high | xhigh | max`；**Ctrl+T** 在会话里循环切换。
- `/status` 一屏看完：会话 ID、名称、生效的设置文件、连接及其端点与模型（附来源）、推理强度（附来源）、最近一次采样用量。

模型能力（上下文窗口、是否支持图片）由内置目录决定，远端刷新失败时用缓存。模型明确不支持图片时，会话会给出提示而不是硬发；能力未知时提示后尝试，但绝不把未知记成支持。

## 让项目记住默认值

会话里选的模型只影响当前会话。想让一个目录的新会话默认用某个模型：

```bash
rind config set model <model> --folder [dir] [--connection <id>]
rind config set effort <level> --folder [dir]
rind config unset model|effort --folder [dir]
```

优先级：**会话 > 目录自身（`~/.rind/workspaces.json`，按目录键保存）> 用户默认（`~/.rind/settings.json`）**。Git worktree 没有自己的设置时，沿用它主仓库的值。

## 图片怎么进上下文

在 prompt 里写下相对工作区 `uploads/` 目录的路径即可，例如：

```text
uploads/screenshot.png 这个报错是什么意思
```

系统会把图片快照进会话（格式、大小、数量限制见[图片进入上下文](../internals/02-context/image-input.zh-CN.md)），后续请求从快照读取，不再打开原文件。

[返回场景索引](README.zh-CN.md)
