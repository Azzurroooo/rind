# A Tool Call: First a Fact, Then an Interface Result

English | [简体中文](tool-call-lifecycle.zh-CN.md)

A finished tool execution is not yet a committed call. ToolCallProcessor must normalize the result and write it to the session before it can deliver the call to the next model request and to the notification system.

~~~mermaid
sequenceDiagram
    participant R as TurnRunner
    participant P as ToolCallProcessor
    participant X as ToolExecutor
    participant S as SessionStore
    R->>S: save the assistant's tool_calls
    R->>P: ParsedToolCall(call_id, name, raw_args)
    P->>S: look up any existing record for this call_id
    alt existing result
        S-->>P: reuse the result
    else new call
        P->>X: validate and execute
        X-->>P: structured execution result
    end
    P->>S: save the tool record and the tool message
    P-->>R: tool_result event
    R->>R: next sampling
~~~

A batch of tools executes in order: async handlers are awaited directly, and sync handlers run in a thread; results are committed in the original call order.

The processor emits start, heartbeat, result, and other events. A result persistence failure raises PersistenceError and prevents normal continuation, so that the UI does not show success while the later model has no result. During recovery, the processor first checks for an existing call ID and does not re-execute an already recorded result; when no record exists, success must not be assumed merely because the UI once displayed progress.

## Result Commit Is Also a Cross-Turn Latch

A bash command may exit before its initial call has written the tool result. If the process observer directly triggers the next turn, the history might still contain only the assistant tool_calls. The processor notifies the task system of committed only after persistence, and continuation also requires the tool pairing to be closed; these two conditions decouple process speed from the order of conversation commits.

Likewise, "finding an existing result" means reusing a committed fact, and is not limited to successful results. Recovery must preserve the information from a failure, and must not treat that failure as never executed and automatically retry its side effects. Parallel delegation also commits in the original call order, so that the next model request sees a stable pairing.

Code entry points: [processor](../../../agent/application/tools/processor.py), [executor](../../../agent/application/tools/executor.py), [tool records](../../../agent/infrastructure/persistence/tool_call_repository.py). Verification: [tool processor](../../../test/test_async_tool_call_processor.py), [persistence failure](../../../test/test_tool_persistence_failure.py).

[Back to the series map](../README.md)
