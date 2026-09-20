# Context compaction

Compaction replaces older context with a user continuation message and an assistant summary, followed by the retained recent conversation and any messages added after the boundary. Recent assistant tool calls remain paired with their results, including their original reasoning content. Raw history stays available on disk.

The summary's generation reasoning is not stored in new compaction handoffs. When projecting either new or legacy handoffs into model messages, Rind supplies the existing fixed, nonempty `COMPACT_HANDOFF_REASONING_CONTENT` in place of generation reasoning. This preserves the assistant message contract without replaying the summary model's reasoning. Existing compaction files are not rewritten; ordinary assistant reasoning is unchanged.

Provider-reported compact usage is recorded before validating the summary, including reasoning token counts. Empty summaries or explicit non-success finish reasons (such as a token limit) use the existing deterministic fallback rather than accepting partial text as a completed summary. Provider failures without reported usage cannot be assigned a known token cost. Cancellation propagates without committing a compaction boundary.

Regression tests cover summary validation, usage accounting, message pairing, and session recovery. Real-provider acceptance runs separately, only when requested, and verifies auto-triggered compaction, tool continuation, the next turn, and recovery through the CLI in an isolated workspace and RIND_HOME. Clean up its processes, sessions, traces, and temporary settings afterwards. Compatibility claims apply to the providers actually tested.
