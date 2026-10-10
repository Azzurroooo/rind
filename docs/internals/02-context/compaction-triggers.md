# Compaction has three entrances, one main pipeline

English | [简体中文](compaction-triggers.zh-CN.md)

User-initiated compaction, reaching the automatic threshold, and the Provider rejecting an overly long context are triggered in different ways, but summary generation and boundary commit all share the same CompactionService.

~~~mermaid
flowchart TD
    MAN["/compact or rind/session/compact"] --> PIPE["CompactionService"]
    AUTO["ContextManager decides the threshold is reached"] --> PIPE
    ERR["Provider context-length error"] --> PIPE
    PIPE --> CORPUS["Prepare corpus and retained suffix"]
    CORPUS --> SUM["Generate handoff"]
    SUM --> COMMIT[("Commit the compaction boundary")]
    COMMIT --> REBUILD["Rebuild context"]
~~~

Manual compaction occupies the session's execution slot, emitting turn_started with operation=compact, context_compacted, and a terminal state; without new input it starts no extra conversation sampling. Automatic compaction happens before sampling in the current turn, and the original turn_id is unchanged. A first context-length error attempts compaction; later recovery tightens the hard limit and enables explicit context rescue.

The compaction service only generates and commits the handoff; **whether to continue sampling is decided by the caller**. If the pre-summary input budget precheck fails, the old context is kept and the error is raised directly, the model is not called, and that error is not disguised as a deterministic fallback after a summary failure.

## Each entrance determines the follow-up action

| Entrance | Turn identity and follow-up action |
| --- | --- |
| Manual compact | Occupies the execution slot exclusively and reports a maintenance-operation terminal state; holds no extra conversation without input |
| Automatic threshold trigger | Tidies up context before the next sampling in the current turn and continues the original task |
| context-length error | The first attempt compacts; later attempts tighten the hard limit and attempt rescue, under bounded recovery |

The automatic threshold follows ContextManager's budget decision; it does not trigger on "more than N messages". A provider can still reject input sooner than the local estimate predicts, so error recovery is a necessary complement, and tightening the hard limit by 0.8 for later attempts does not mean retrying without bound until something happens to succeed.

Code entry points: [TurnRunner](../../../agent/runtime/core/turn_runner.py), [CompactionService](../../../agent/application/context/compaction.py), [manual entrance](../../../agent/runtime/core/runtime.py). Verification: [compaction mainline](../../../test/test_compact_pipeline.py), [input and compaction](../../../test/test_compact_input_lifecycle.py).

[Back to the series map](../README.md)
