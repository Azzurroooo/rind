# Session on-disk structure: small files, one job each

English | [简体中文](session-store.zh-CN.md)

SessionStore does not mash the conversation, tools, and metadata into one large object. JSONL holds appendable facts, while meta.json holds the updatable session state and its summary.

~~~mermaid
flowchart TB
    ROOT["~/.rind/sessions/session_id/"] --> META["meta.json<br/>model · goal · terminal state"]
    ROOT --> MSG["messages.jsonl<br/>message facts"]
    ROOT --> TOOL["tool_calls.jsonl<br/>tool calls and results"]
    ROOT --> COMP["compactions.jsonl<br/>compaction records, on demand"]
    ROOT --> TASK["tasks.jsonl<br/>managed process facts, on demand"]
    ROOT --> ATT["attachments/ and tool-output/"]
    INDEX["~/.rind/session_index.json"] --> ROOT
~~~

JsonlSessionStore delegates to MessageRepository, ToolCallRepository, CompactionRepository, and SessionIndexRepository. The default data root is RIND_HOME/sessions; an explicit session_dir uses its own index.json. When a session is first created, meta, messages, and tool_calls exist from the start, and the other files appear as their features do. A session is bound to a workspace, and restoration validates the schema and identity.

SessionFiles serializes reads and writes with a file lock; JSONL appends are followed by flush/fsync, and JSON files such as meta are written to a temporary file in the same directory and then replaced. The index exists to list sessions quickly and must not be treated as the only source of complete history. This layout lets reading history, inspecting metadata, and reading background-process logs each take the path that suits it.

## Single-file reliability and cross-file consistency are handled separately

Temporary replacement in JSON avoids reading half a meta, and JSONL appends keep old messages from being rewritten; the file lock and fsync address contention and commit separately. But one business operation may write several files, so these local mechanisms must not be merged into a description of a database transaction.

Compaction, for example, writes its record first and the boundary message afterwards; the projection must find a valid match in both, and an orphaned half must not change the model context. Tool call records and messages are likewise re-associated by call ID, with a missing result presented as an explicit placeholder. The tolerant rules for ordinary history reads differ from TaskJournal's strict journal repair rules; you cannot assume every JSONL skips corrupt lines in the same way.

plan.json is also an on-demand session control file. The raw conversation, the current plan, and the process logs are read and written separately, so replaying history need not load every large output, and a plan change does not require rewriting the conversation.

Code entry points: [JsonlSessionStore](../../../agent/infrastructure/persistence/jsonl_session_store.py), [SessionFiles](../../../agent/infrastructure/persistence/session_files.py). Verification: [asynchronous session store](../../../test/test_async_session_store.py), [session fork](../../../test/test_persistence_session_fork.py).

[Back to the series map](../README.md)
