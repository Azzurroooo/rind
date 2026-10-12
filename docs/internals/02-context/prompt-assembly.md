# Where model instructions come from

English | [简体中文](prompt-assembly.zh-CN.md)

The system prompt is not a string that keeps growing by appending. Rind separates stable identity, workspace rules, runtime capabilities, and session history, and assembles them from their sources before every request.

~~~mermaid
flowchart TB
    BASE["Base system prompt + environment"] --> CM["ContextManager"]
    DOC["User / project RIND.md"] --> CM
    TOOLS["Guidance for the session's own tools"] --> CM
    GOAL["Goal policy"] --> CM
    TEAM["Agent identity / Team catalog"] --> CM
    SKILL["Skill metadata catalog"] --> CM
    HIST[("Session message projection")] --> CM
    CM --> REQ["Model message list"]
~~~

The composition root calls build_system_prompt to create the base prompt; a Team Agent's system.md contributes its identity; and when Goal is enabled, the Goal policy is injected as well. ContextManager reads the user-level and project-level RIND.md, injecting at most 32 KiB from each and recording any truncation or read error; the Skill catalog injects only a metadata index, rather than stuffing every Skill body into each turn's request.

The base prompt describes the tools every session has. Guidance for a tool only some sessions have, today ask_user_question, is a runtime message built from the session's registered tools, so the prompt never describes a tool the session lacks; a saved older prompt is brought up to date when the history is read.

Runtime messages are inserted after the first system message, and recent session messages keep their original order. A Goal checkpoint is transient input for a single continuation, and the goal the user states is marked as data rather than a higher-priority instruction. Every category of injection is visible in context stats/decisions, so "why does the model know this?" no longer has to be guessed.

Code entry points: [system prompt](../../../agent/prompts.py), [RIND.md loading](../../../agent/infrastructure/rind_docs.py), [context assembly](../../../agent/application/context/manager.py). Verification: [prompt regression](../../../test/test_prompts.py), [RIND.md regression](../../../test/test_rind_docs.py).

[Back to the series map](../README.md)
