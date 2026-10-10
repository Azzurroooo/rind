# Context budget: estimation and real usage calibrate each other

English | [简体中文](context-budget.zh-CN.md)

The model window is the ceiling, the local estimate taken before sending is an early warning, and the actual usage returned by the Provider calibrates the next round of judgment. Rind does not pass character counts off as exact tokens.

~~~mermaid
flowchart LR
    MSG["Current messages"] --> EST["Local estimate<br/>tiktoken or heuristic"]
    USAGE["Last assistant measured input tokens"] --> ANCHOR["Same model / same compaction generation check"]
    EST --> ANCHOR
    ANCHOR --> ACTIVE["Active token estimate"]
    ACTIVE --> LIMIT{"Auto-compaction line reached?"}
    LIMIT -->|"Yes"| COMPACT["Trigger compaction"]
    LIMIT -->|"No"| SAMPLE["Continue sampling"]
~~~

ContextBudget keeps the window, a hard limit, and the diagnostic budgets for system, conversation, and tool; the default auto-compaction line is 90% of the window. ContextEstimator prefers a tokenizer, falling back to an English-and-CJK heuristic when the tokenizer fails, and counts images separately. The partitioned budgets are used to report pressure; they do not imply per-category hard truncation.

A usable measured anchor must come from assistant sampling, and its compaction generation, model, and local estimate must pass validation; otherwise the system falls back to the local estimate. When the anchor is valid, the last server-side input tokens are added to the local increment, with the ratio clamped to 0.2-2.0. context inspect shows these sources and decisions, making the reason for automatic compaction explainable.

## What the calibration formula actually means

With a usable anchor, the active estimate is approximately: last server-side input tokens + local increment tokens x clamp(last server-side input / last local estimate, 0.2, 2.0). For example, if the last round had 10,000 server-side tokens and 8,000 local ones, and this round adds 800 locally, the active estimate is 11,000. When the model changes, compaction occurs, or the local estimate shrinks instead, this growth anchor can no longer be carried over.

When there is no reliable model window, the default window is 256,000 tokens, and known model capabilities override it. Locally, cl100k_base is preferred, falling back to CJK/other-text heuristics when no tokenizer is available. The 90% trigger line therefore provides headroom, but it does not guarantee that a provider will never reject a request; the context-length error recovery path is still needed.

Code entry points: [estimator](../../../agent/application/context/estimator.py), [anchor logic](../../../agent/application/context/manager.py), [usage normalization](../../../agent/application/context/token_usage.py). Verification: [estimation regression](../../../test/test_context_estimator.py), [budget regression](../../../test/test_compact_budget.py).

[Back to the series map](../README.md)
