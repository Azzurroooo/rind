# ContextManager: turning session facts into model requests

English | [简体中文](context-manager.zh-CN.md)

ContextManager does not take UI screen text as its input; it takes SessionStore's projection of history. It overlays dynamic instructions, computes the budget, and emits model messages free of internal markers.

~~~mermaid
flowchart LR
    STORE[("Persisted session")] --> PROJECT["Message projection"]
    PROJECT --> MERGE["Merge pending and system injections"]
    DOC["RIND.md / Skill catalog / transient system messages"] --> MERGE
    MERGE --> EST["ContextEstimator"]
    EST --> STATS["stats + decisions"]
    EST --> STRIP["Strip internal _context_kind"]
    STRIP --> MODEL["Model messages"]
~~~

build_messages_async first takes a session slice that includes internal messages, then adds the pending overlay. RIND.md, transient system messages, and the Skill catalog are inserted after the first system message. A copy tagged with _context_kind serves the composition snapshot, and those internal fields are stripped before the result is actually sent to the model. The result carries messages, stats, and decisions together: system, conversation, and tool estimates, for instance, plus whether automatic compaction is triggered.

On the normal path, no user request is silently dropped just because earlier messages run long. Only when context-overflow recovery explicitly enables allow_rescue are the oldest cold messages replaced with placeholder text, while the trailing hot messages are kept; this is not regular compaction, and it does not rewrite on-disk history.

## One composition, two outputs

ContextBuildResult carries messages, internal_messages, stats, and decisions at once: messages go to the model, internal_messages retain their source labels for inspection, stats give the budget readings, and decisions explain the injection and recovery choices. The inspection panel and the real request come from the same composition, which reduces the drift of a panel that estimates one set of numbers while another set is actually sent.

For example, if the workspace rules change but the old conversation does not, the next composition reloads RIND.md for injection; the new rules do not have to be passed off as old history messages. Conversely, an already activated Skill body has a session snapshot, and the content of that past invocation must not be quietly replaced just because the original SKILL.md later changed.

A history read failure becomes a PersistenceError; a read exception must not be treated as "this is an empty session" and execution simply continued. This is the key failure boundary at the projection entry point.

Code entry points: [ContextManager](../../../agent/application/context/manager.py), [session projection](../../../agent/infrastructure/persistence/message_projector.py), [context snapshot](../../../agent/application/context/snapshot.py). Verification: [ContextManager tests](../../../test/test_context_manager.py), [context snapshot](../../../test/test_context_snapshot.py).

[Back to the series map](../README.md)
