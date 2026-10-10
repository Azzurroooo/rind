# From raw history to the model view: the on-disk original is not what the model sees

English | [简体中文](message-projection.zh-CN.md)

Disk holds the raw messages and tool records, while the model request and UI replay each need a different view. The projection functions select, fill in, and validate; they do not "fix history" by rewriting old files.

~~~mermaid
flowchart LR
    RAW[("messages.jsonl")] --> P["project_messages"]
    TOOLS[("tool_calls.jsonl")] --> P
    COMPACT[("compactions.jsonl")] --> P
    P --> MODEL["model view<br/>latest handoff + retained suffix"]
    P --> UI["replay view<br/>message id + timestamp"]
~~~

The assistant's tool_calls metadata is aligned with the tool records by call ID; if a result is missing, the projection emits an explicit "result unavailable, the call may have run" placeholder rather than pretending the result succeeded. A tool's model_content enters later context exactly as saved; changes to the terminal preview never quietly rewrite history. Skill snapshots and task notifications are available to the model, while the UI filters internal notifications by default.

Only the latest valid compact_boundary changes the model view: older content is replaced by a continuation user message and an assistant handoff, and the suffix kept verbatim is appended as usual. When the UI wants history IDs and timestamps it turns include_ids on explicitly; the model view does not carry these display fields by default. If message boundary validation fails after a compaction has been applied, the projection is rejected rather than forwarding broken tool messages.

## A missing result must not be "patched into success"

If disk holds an assistant call c1 but no result for c1, the projection builds a "result unavailable" explanation: the call may have run, and it may not have. The model therefore sees a complete call-result shape while still knowing the result is uncertain. It does not infer success from the UI's progress text, and it should not repeat a side-effecting operation unconditionally on that basis.

Finding a valid compact pair and running the post-projection boundary check are two steps: when no matching valid compaction pair exists, that compaction is not applied; only if the tool/handoff structure is invalid after it has been applied is that projection rejected. Options such as include_internal, include_ids, and compacted decide which view a reader needs and do not change the on-disk original.

Code entry points: [message projection](../../../agent/infrastructure/persistence/message_projector.py), [boundary validation](../../../agent/domain/message_boundary.py). Verification: [compaction projection](../../../test/test_compact_pipeline.py), [replay timing](../../../test/test_replay_message_time.py).

[Back to the series map](../README.md)
