# Plan: Persist Step State, Preserve Progress During Compaction

English | [简体中文](plan.zh-CN.md)

The plan is the current session's control state. update_plan submits a complete list every time, avoiding hard-to-track partial changes when individual steps are added or removed.

~~~mermaid
flowchart LR
    M["update_plan: complete ordered list"] --> V["normalize_plan"]
    V --> F[("session plan.json")]
    F --> S["build_plan_snapshot"]
    S --> H["compaction handoff attaches the plan snapshot"]
    M --> E["plan_updated / tool_result"]
    E --> UI["Surface plan view"]
~~~

Each item contains step and status; the statuses are pending, in_progress, completed, and cancelled, with at most one in_progress. Array order is the display and execution priority; an empty list clears the plan. File writes use a temporary file in the same directory and a replacement, and require the session to already be persisted.

During compaction, CompactionService reads a bounded summary of the current plan.json and attaches it to the handoff, so the model does not depend solely on an update_plan call from much earlier in the conversation. A plan describes "what still needs to be done" and should not carry factual research notes.

The plan_updated event is emitted as soon as TurnRunner parses the model's call; by itself it cannot prove that the plan.json write succeeded, and in the end it is the tool_result that counts. This distinction also applies to the UI: declaring that an update is about to happen and having committed an update are different stages.

## One Plan Has Only One Current Value

~~~json
{"plan":[{"step":"Locate the failure","status":"completed"},{"step":"Fix and run the regression","status":"in_progress"}]}
~~~

This is the shape of update_plan's arguments, not the complete on-disk format of plan.json; the on-disk file also carries schema_version. The next submission must provide a complete new list; an old step that is not in the list is not part of the current plan. The schema and status validation performed at write time prevents the UI and the model from each guessing their own plan structure.

A corrupted plan file must not be treated by default as "all tasks are done". Read errors must be reported clearly, and attaching the plan during compaction uses best-effort reading; even when the plan is absent, the original tool and message facts remain available for tracing, but a new handoff must not fabricate progress.

Code entry points: [plan tools](../../../agent/infrastructure/tools/planning.py), [plan storage](../../../agent/infrastructure/persistence/plan.py), [plan specification](../../../agent/domain/planning.py). Verification: [plan tools](../../../test/test_plan_tool.py), [session isolation](../../../test/test_plan_session_isolation.py), [compaction summary](../../../test/test_plan_context_summary.py).

[Back to the series map](../README.md)
