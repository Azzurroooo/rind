# 不进场也能用 Rind

English | [简体中文](automation.zh-CN.md)

目标：不打开交互界面，也能拿到一个答案、往正在跑的会话里插一句话。

## 一次拿答案：rind run

```bash
rind run --prompt "检查当前 diff 是否包含破坏性 API 变更" --dir /path/to/project > review.md
```

行为约定，写脚本前先记住：

| 约定 | 说明 |
| --- | --- |
| 最终回答进 **stdout** | 直接重定向即可；其余都是 stderr |
| 进度与诊断进 **stderr** | stdout 保持干净，可进管道 |
| `logs/` 下有运行摘要 | Markdown，写在启动目录 |
| 用户提问被禁用 | 需要提问时直接失败，不挂起等输入 |
| 失败返回非零退出码 | 用法错误退出码为 2 |

它默认会等本次任务**以及必要的续接**：这轮拉起的后台任务完成后自动续跑，直到给出一个最终答案——所以"跑测试并总结失败"这类一条龙任务不需要你轮询。

接续已有会话用 `--session <id>`。

## 往正在跑的会话插话：rind send

```bash
rind send --session 20260825_101530_ab12cd34 "集成测试失败了，先排查再继续"
```

投递语义：最近显示该会话的窗口会像收到手动输入一样处理它——空闲就开一轮，忙就进 steering；没有窗口打开时，仍在运行的回合会把它收为 follow-up。投递成功立即确认，但那只是"已收到"，不等于任务完成。

会话 ID 见目标 CLI 的启动横幅或 `/status`。

## 配置默认值：rind config

```bash
rind config set model gpt-5 --folder /path/to/project
rind config unset effort --folder /path/to/project
```

逐目录固化新会话的模型与推理强度，无需交互。详见[让项目记住默认值](models.zh-CN.md#让项目记住默认值)。

## 无 API key 的演示：rind tour

`rind tour [page]` 播放模拟会话：真实 CLI 渲染，不调模型、不改文件。写文档、录屏、给同事演示都能用。

[返回场景索引](README.zh-CN.md)
