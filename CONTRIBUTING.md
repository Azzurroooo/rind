# Contributing

## Tests

Deterministic regression tests in `test/` and `frontend-cli/test/` run during normal development. This includes integration tests using local fake providers. User-scenario acceptance plans in [`test/manual/`](test/manual/README.md) run **only on explicit user request**, independently of regression commands and CI. Live-provider testing can consume tokens and must stay within the requested scope and budget. See the [testing guide](test/README.md) for the distinction and execution rules.

Manual acceptance must also clean up all artifacts and processes it creates, including failed or interrupted runs. Default to a sanitized report in the final response, with no retained test files; retain artifacts only on explicit user request. Follow the [cleanup procedure](test/manual/README.md#清理与零残留验收).

## Implementation principles

1. This project is committed to achieving a lightweight, minimum-viable implementation while still delivering complete functionality and a polished experience — without sacrificing functionality or usability. The implementation must stay clean and minimal, with clear, consistent boundaries/interfaces. Avoid bloated or overly complex feature implementations.

2. At the code level, functionality must be implemented while strictly avoiding redundant logic and redundant fields. Do not add unused variables, interfaces, or branches "just in case." Naming must be precise and unambiguous, with zero conflicts, such that the code is self-explanatory without requiring comments. Do not introduce an entity unless it is truly necessary (YAGNI).

3. Dependencies must be unidirectional — if A depends on B, B must never depend back on A. Any circular dependency indicates a missing shared abstraction layer; extract and push it down accordingly. Interfaces are the boundary — modules must communicate only through explicit interfaces, and must never reach into another module's internal state. Structurally similar components must share a unified interface — for functionality of the same category (e.g., multiple data sources / handlers / providers), a single consistent interface convention must be used; do not invent a new style each time one is added. Zero implicit coupling — no global mutable state, no hidden execution-order dependencies, no silent side effects; all dependencies must be passed explicitly. Favor lightweight solutions — do not introduce abstraction layers, design patterns, or frameworks unless necessary; if a function suffices, don't write a class.

4. During optimization, clean up any obsolete logic or leftover code produced during the modification process. Fix any code segments that are ambiguous or inefficient.
