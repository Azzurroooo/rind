# The usage ledger: every number has a raw record

English | [简体中文](usage-ledger.zh-CN.md)

Token usage both helps decide when to compact and lets the user see consumption; neither purpose should depend on the interface guessing the length of streamed text.

~~~mermaid
flowchart LR
    MODEL["model sampling usage"] --> N["normalize input / cached / output / reasoning"]
    COMPACT["compaction summary sampling usage"] --> N
    N --> META[("recent session usage")]
    N --> LEDGER[("~/.rind/usage.jsonl")]
    LEDGER --> SUM["sum by time window / model / session"]
    SUM --> UI["rind/usage/summary"]
~~~

TurnRunner and CompactionService record the assistant and compact samplings respectively; known Provider usage is recorded faithfully even when the summary is discarded. Session meta stores the recent sampling and the context anchor for the next budget decision, and the user-level usage.jsonl is appended under a file lock, so cross-session summaries do not depend on any live container.

summarize_usage is a pure reduction: 7 days by default and at most 365, grouped by day, model, and recent session, and it invents no cost figures that have no raw record. When the Provider returns no usage, a local estimate must not be passed off as a billed amount; the missing-field and summary-fallback rules are covered below.

## How to read the summary fields

Every ledger record carries sampling_kind, session_id, model, ts, and the normalized usage. Summaries are grouped by day, and the model board and the recent sessions each show at most 5 entries; when total_tokens is positive it is used, otherwise the volume is input_tokens + output_tokens. cached and reasoning are reported separately rather than blindly added to the total, which avoids double-counting subdivided statistics.

When no usage is returned at all, no precise ledger record is generated for that sampling; when there is a usage object but a field is missing, normalization may record it as 0. "No record" and "no consumption" are therefore not the same conclusion. A ledger write is still a best-effort diagnostic path: when it fails, check the logs, and do not treat a summary as a strict mirror of the provider's bill.

Code entry points: [usage ledger](../../../agent/infrastructure/persistence/usage_ledger.py), [summary](../../../agent/application/usage_summary.py), [usage normalization](../../../agent/application/context/token_usage.py). Verification: [ledger regression](../../../test/test_usage_ledger.py), [summary regression](../../../test/test_usage_summary.py).

[Back to the series map](../README.md)
