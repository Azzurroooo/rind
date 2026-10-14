# 第一次把任务跑完

English | [简体中文](first-task.zh-CN.md)

目标：从零开始，看着 Rind 真正完成一个任务——读文件、改代码、跑命令。

## 装好并启动

```bash
npm install -g @rind-ai/cli     # Node.js 18+
cd your-project
rind
```

没有 npm 环境可以用 Releases 里的独立安装包（Windows x64 / macOS / Linux x64）；源码运行见[从源码运行 CLI](../internals/07-surfaces/interactive-cli.zh-CN.md#从源码运行)。

启动横幅会告诉你三件事：**当前模型、会话、工作目录**。注意此时还没有会话——会话在第一条消息发出时才创建。

## 接上模型

第一次运行需要先接一个模型供应商：

```text
/login
```

跟着菜单走即可（ChatGPT 订阅登录、API Key、或自定义 OpenAI 兼容端点）。多个供应商与复杂的模型选择策略见[让 Rind 用上你指定的模型](models.zh-CN.md)，这里先用默认值往下走。

`/model` 查看或切换当前模型；`/status` 看当前连接状态。

## 派第一个任务

在输入框里用自然语言描述任务，Enter 发送：

```text
读一下 src/parser/tokenizer.js，总结它怎么处理 unicode，再补上对应测试
```

回合进行中你会看到工具调用逐条出现（`read_file`、`bash`……），它们默认折叠，只显示一行摘要。想看完整输出，按 **Ctrl+O** 展开/收起。

助手回复带表格、代码块的富文本由 Markdown 渲染器直接排版。流式文字是增量事件，最终以落盘消息为准，所以刷新或断线不会丢内容。

## 中途的两种交互

- **它可能向你提问**：工具需要你拍板时，输入框让位给选项菜单，↑↓ 选择、Enter 确认、Esc 不作答并中断本轮。非交互的 `rind run` 不支持这种提问，会直接失败。
- **你想改方向**：现在就能打字发送。 steering / 排队 / 打断的完整语义见[干到一半，把活掰回正轨](steer-the-work.zh-CN.md)。

## 结束与退出

- `/exit`（或 `/quit`）退出；Ctrl+C 在回合运行中是中断（再按一次强制收尾），空闲时连按两次退出（2 秒内）；输入框里有没发出去的文本时，它先清空输入。
- 会话自动保存。想接着干：`rind --session <id>` 直接恢复，或 `/sessions` 翻出近期的会话，见[回来继续干](resume.zh-CN.md)。
- 只想先看看它长什么样，不需要 API key：`rind tour` 播放模拟演示，或会话内 `/tour`。

[返回场景索引](README.zh-CN.md)
