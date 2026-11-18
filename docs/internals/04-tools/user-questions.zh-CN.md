# 用户问答：工具等待由协议闭合

English | [简体中文](user-questions.md)

ask_user_question 没有自己读终端。ToolCallProcessor 把问题变成事件，ExecutionCoordinator 保存等待中的答复，Surface 通过协议把用户答案送回来。

~~~mermaid
sequenceDiagram
    participant M as 模型
    participant P as ToolCallProcessor
    participant E as ExecutionCoordinator
    participant S as Surface
    M->>P: ask_user_question
    P->>P: 校验问题与选项
    P-->>S: user_question_requested
    P->>E: 等待 responder
    S->>E: rind/user-question/respond
    E-->>P: 用户答案
    P-->>M: 持久化后的 tool 结果
~~~

每次调用传入 `questions`（1 到 4 题），每题包含非空 `question`、可选短标题 `header`、可选多选标记 `multiple` 以及可选 `options`（由 `label` 和 `description` 组成；有推荐项时放在首项并以“ (Recommended)”结尾，各端 UI 自动提炼为推荐徽标，无客观优劣的偏好题不强制要求推荐标记）。用户始终可自由输入；各端通过协议回传与题目对齐的 `answers: string[][]`，并绑定 `session_id` 与 `tool_call_id`，不能把旧会话的问题误答到新工具调用上。

等待者属于活跃执行，取消会释放它；这样释放的问题记为已取消，而不是空答案。跳过问题（CLI 按 Esc 或 Desktop/Web/Mobile 点击 Skip）会提交空 `answers: []` 而不中断本轮，返回 UserQuestionEmptyAnswer，让模型在未获答复的情况下继续执行。缺少 responder 时返回 UserQuestionUnsupported，不能假装已经得到确认。rind run 启动 Worker 时传 --no-user-question，Team 执行委派也关闭用户问答，让无人值守调用保持明确的交互边界。

## 等待需要稳定关联，也需要退出路径

一次问答用 session_id 与 tool_call_id 定位等待者：前端重连或切换会话后，仍必须答复原来的调用，不能只发一段没有来源的“同意”。ExecutionCoordinator 检查等待是否还存在，再解除工具等待；已取消的旧问题不能恢复为新的授权。

问答工具的普通 handler 本身只返回 Unsupported，真正的交互由运行时处理器与 responder 接合。这使执行内核不需要知道用户在终端输入、点 Desktop 选项还是从消息渠道回复数字。无交互环境在装配时关闭能力，而不是执行到一半才尝试读取 stdin；此时系统提示里也不会再介绍这个工具。

代码入口：[问答声明](../../../runtime/src/infrastructure/tools/control-tools.ts)、[问答处理](../../../runtime/src/application/tool-processor.ts)、[等待者管理](../../../runtime/src/server/execution.ts)。验证：[处理器测试](../../../runtime/test/context-and-turn.test.js)、[one-shot 测试](../../../frontend-cli/test/one-shot.test.js)。

[返回系列地图](../README.zh-CN.md)
