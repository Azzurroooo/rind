# 用户问答：工具等待由协议闭合

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

问题必须是非空字符串；可选选项由 label 和 description 组成，第一项 label 以“ (Recommended)”结尾，其他项不能使用该后缀。用户仍可自由输入，选项只是交互辅助。答案关联 session_id 与 tool_call_id，不能把旧会话的问题误答到新工具调用上。

等待者属于活跃执行，取消会释放它；缺少 responder 时返回 UserQuestionUnsupported，不能假装已经得到确认。rind run 启动 Worker 时传 --no-user-question，Team 执行委派也关闭用户问答，让无人值守调用保持明确的交互边界。

## 等待需要稳定关联，也需要退出路径

一次问答用 session_id 与 tool_call_id 定位等待者：前端重连或切换会话后，仍必须答复原来的调用，不能只发一段没有来源的“同意”。ExecutionCoordinator 检查等待是否还存在，再解除工具等待；已取消的旧问题不能恢复为新的授权。

问答工具的普通 handler 本身只返回 Unsupported，真正的交互由运行时处理器与 responder 接合。这使 Python 内核不需要知道用户在终端输入、点 Desktop 选项还是从消息渠道回复数字。无交互环境在装配时关闭能力，而不是执行到一半才尝试读取 stdin。

代码入口：[问答声明](../../../agent/infrastructure/tools/user_question.py)、[问答处理](../../../agent/application/tools/processor.py)、[等待者管理](../../../agent/runtime/server/execution.py)。验证：[处理器测试](../../../test/test_async_tool_call_processor.py)、[one-shot 测试](../../../frontend-cli/test/one-shot.test.js)。

[返回系列地图](../README.md)
