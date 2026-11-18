# User Questions: The Tool Wait Is Closed by the Protocol

English | [简体中文](user-questions.zh-CN.md)

ask_user_question does not read the terminal itself. ToolCallProcessor turns the question into an event, ExecutionCoordinator holds the pending answer, and the Surface returns the user's answer over the protocol.

~~~mermaid
sequenceDiagram
    participant M as model
    participant P as ToolCallProcessor
    participant E as ExecutionCoordinator
    participant S as Surface
    M->>P: ask_user_question
    P->>P: validate the question and options
    P-->>S: user_question_requested
    P->>E: wait for the responder
    S->>E: rind/user-question/respond
    E-->>P: user answer
    P-->>M: the persisted tool result
~~~

Each call passes `questions` (1 to 4 items), where each item carries a non-empty `question`, optional short `header`, optional `multiple` flag, and optional `options` (`label` + `description`; when recommending an option, the model places it first with `" (Recommended)"`, which Surfaces extract as a badge without hard-failing neutral preference questions). The user can always type freely; Surfaces return `answers: string[][]` tied to `session_id` and `tool_call_id`, so a question from an old session must not be answered against a new tool call.

A waiter belongs to active execution, and cancellation releases it; a question released that way is recorded as cancelled, not as an empty answer. Skipping a question (Esc in the CLI or Skip in Desktop/Web/Mobile) submits empty `answers: []` without interrupting the turn, returning UserQuestionEmptyAnswer so the model can continue without a user answer. When there is no responder, it returns UserQuestionUnsupported rather than pretending that confirmation was already obtained. rind run starts the Worker with --no-user-question, and Team execution delegation also disables user questions, keeping unattended calls behind a clear interaction boundary.

## Waiting Needs a Stable Association, and Also a Way Out

A single question-and-answer exchange locates its waiter by session_id and tool_call_id: after the frontend reconnects or switches sessions, it must still answer the original call, and cannot just send an unsourced "agreed". ExecutionCoordinator checks whether the wait still exists before releasing the tool's wait; a cancelled old question cannot be revived as a new authorization.

The question tool's ordinary handler returns Unsupported on its own; the real interaction is joined by the runtime processor and the responder. This means that the execution kernel does not need to know whether the user typed in the terminal, clicked a Desktop option, or replied with a number from a messaging channel. Non-interactive environments disable the capability at assembly, instead of trying to read stdin halfway through execution; the system prompt then says nothing about the tool either.

Code entry points: [question declaration](../../../runtime/src/infrastructure/tools/control-tools.ts), [question handling](../../../runtime/src/application/tool-processor.ts), [waiter management](../../../runtime/src/server/execution.ts). Verification: [processor tests](../../../runtime/test/context-and-turn.test.js), [one-shot tests](../../../frontend-cli/test/one-shot.test.js).

[Back to the series map](../README.md)
