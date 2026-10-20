# 快捷键与命令速查

English | [简体中文](cheatsheet.zh-CN.md)

一屏看完 CLI 的键位与命令。忘了就来查这一页。

## 键位

| 键 | 场景 | 作用 |
| --- | --- | --- |
| Enter | 任意 | 发送输入 |
| Shift+Enter / Ctrl+Enter | 写多行 prompt | 换行 |
| Tab | 回合进行中 | 把输入排队为 follow-up（回合结束后自动发送） |
| Enter | 回合进行中 | 作为 steering 送入，下一次采样前生效 |
| Alt+↑ | 有待处理 follow-up | 取回编辑器 |
| Alt+↓ | 有待处理 steering | 取回编辑器 |
| Alt+→ | 有待处理 follow-up | 提升为 steering |
| Ctrl+C | 回合运行中 / 空闲（2 秒内连按）/ 有未发送文本 | 中断回合（再按强制收尾）/ 退出 / 先清空输入 |
| Ctrl+O | 任意 | 展开/收起工具输出 |
| Ctrl+T | 任意 | 循环推理强度 |
| Ctrl+B | 任意 | 打开/关闭后台任务监视器 |
| ↑ / ↓ | 输入框 | prompt 历史 |
| Esc | 斜杠菜单 / 监视器 | 关闭当前菜单或监视器（菜单开着时先关菜单） |
| ← | 空输入框 | 打开 Agents Management |

## 斜杠命令

| 命令 | 用途 |
| --- | --- |
| `/help [command]`、`?` | 命令列表与用法 |
| `/login [provider]` | 连接模型供应商 |
| `/logout [provider]` | 移除已存凭证 |
| `/model`、`/model set <model>` | 选择菜单 / 直接指定模型 |
| `/effort [low \| medium \| high \| xhigh \| max]` | 推理强度 |
| `/sessions [limit]` | 列出最近会话 |
| `/history` | 加载当前对话更早一页的消息 |
| `/rename <name>`、`/rename --reset` | 命名会话 |
| `/fork` | 从某条消息分叉会话 |
| `/compact` | 压缩当前上下文 |
| `/context` | 上下文组成与用量面板 |
| `/goal [pause \| resume \| clear \| <目标>]` | 持久目标 |
| `/skill` | Skill 列表、来源与加载问题 |
| `/settings` | 配置全局精简输出与对话读取哪些 Claude 和 Codex Skill |
| `/init [project\|user]` | 起草 RIND.md |
| `/status` | 会话与连接状态 |
| `/theme [name]` | 切换配色 |
| `/tour [page]` | 交互式功能导览 |
| `/exit`（`/quit`） | 退出 |

## 子命令

| 命令 | 用途 |
| --- | --- |
| `rind [--team <id> \| --standalone] [--session <id>]` | 交互式会话；`--team` 指定共享工作区的会话范围，`--standalone` 脱离团队，`--session` 恢复指定会话 |
| `rind run --prompt <text> [--dir <path>] [--session <id>]` | 一次性运行，答案进 stdout |
| `rind send --session <id> "<prompt>"` | 向目标会话投递输入 |
| `rind config set model\|effort <值> --folder [dir] [--connection <id>]`、`rind config unset ...` | 目录级默认值 |
| `rind tour [page]` | 模拟演示导览 |
| `rind agents ...` | 团队管理，见[把工作派给一个团队](teams.zh-CN.md) |
| `rind --help`、`rind --version` | 帮助与版本 |

## 语法糖

| 写法 | 作用 |
| --- | --- |
| `$skill-name` | 在 prompt 里引用一个 Skill |
| `/skill:skill-name` | 整条消息即 Skill 调用 |
| `uploads/xxx.png` | 让回合带上这张图片（相对工作区） |

[返回场景索引](README.zh-CN.md)
