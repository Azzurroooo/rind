# A turn is a loop of repeated sampling

English | [简体中文](turn-loop.zh-CN.md)

One user input produces a single turn_id but may request the model several times: the model proposes a tool call, the tool result enters history, and only the next sampling can see the result.

~~~mermaid
flowchart TD
    U["User input persisted"] --> B["Build the context"]
    B --> M["Model streaming sampling"]
    M --> A["Assistant message persisted"]
    A --> Q{"Any tool calls?"}
    Q -->|"Yes"| T["Execute and commit tool results"]
    T --> B
    Q -->|"No"| I{"Any accepted follow-up input?"}
    I -->|"Yes"| B
    I -->|"No"| E["Turn terminal state persisted"]
~~~

AgentRuntime holds the turn lock, input queues, turn_id, and running state for that session; TurnRunner handles building the context, sampling, parsing the model stream, and executing tool steps. A follow-up can continue the same turn once the previous sampling completes normally; steering is delivered before the next model sampling. Multiple samplings within one turn do not create multiple sessions.

Tool calls and assistant messages first become recoverable records; the terminal state is written only when the model fails, is cancelled, or completes. Before the model continues, the message boundary is validated so that the assistant's tool calls pair correctly with tool results. The incremental text a Surface sees is for display only; recovery ultimately relies on the persisted messages and the turn's terminal state.

## "One turn" is not "one model request"

Suppose the model first reads a file, then modifies it, and finally answers: within the same turn_id you will see "sampling -> read_file -> sampling -> edit_file -> sampling -> final text". Each sampling rebuilds the context, so freshly persisted tool results, already-delivered inputs, and a new compaction boundary only enter the next request.

| Boundary | Condition that must hold |
| --- | --- |
| Before executing a tool | The assistant tool call is saved, and its source can be found by call ID |
| Before requesting the model again | The previous call and result are closed, and the context view is valid |
| When reporting the terminal state | The persisted turn_state can explain completion, failure, or cancellation |

A follow-up can continue sampling within the same turn; background task notifications or Goals have the coordinator start a separate continuation. Only by keeping the two apart can one explain why a single UI submission can produce many incremental events yet should not be rendered as many repeated user requests.

Code entry points: [AgentRuntime.run_turn](../../../agent/runtime/core/runtime.py), [TurnRunner.run_turn](../../../agent/runtime/core/turn_runner.py). Verification: [the async runtime](../../../test/test_async_runtime.py), [user journey regression](../../../test/test_journeys_user.py).

[Back to the series map](../README.md)
