# Pick up where you left off

English | [简体中文](resume.zh-CN.md)

Goal: continue today exactly as yesterday's unfinished work left off; try a different path without breaking the existing history.

## Sessions are saved automatically

Sessions live with their **directory**: `rind --session <id>` finds the directory a session belongs to when resuming it. A session ID looks like `20260825_101530_ab12cd34`, and appears in the startup banner and in `/status`.

```text
/sessions       list recent sessions
/rename <name>  give the current session a memorable name
/status         session ID, name, model and connection, latest sampling usage
```

## Resuming and forking

| Scenario | What to do |
| --- | --- |
| Continue where you left off | `rind --session <id>` resumes it directly; the startup banner replays a snippet of the last exchange first, so you never resume blind |
| See earlier in a very long conversation | The transcript opens on the newest messages and says how many earlier ones are hidden; `/history` loads the previous page each time until the whole conversation is shown |
| Browse past sessions | `/sessions` lists recent sessions; pick with ↑↓ and Enter opens it in **another CLI window**, leaving the current one alone |
| Take a different path from some midpoint | `/fork`, select that message and fork a new session from it; the original history is untouched |
| History too long, want to slim it down deliberately | `/compact`, see below |

`/fork` copies the history up to the selected message; running tasks and credential-like state are not copied with it. After the fork, the two sessions do not affect each other. Note that switching sessions never rewrites workspace files - history is history, files are files.

## What to do when the context overflows

A long session will eventually hit the model window. Rind does not delete history:

- `/context` opens the context panel: two pages, the first is this session's **composition** (system prompt, RIND.md, Skill catalog, messages... how much each takes up), the second is **budget and usage**. Tab / ← / → switch pages, Esc closes.
- `/compact` compacts actively: it replaces the old history with a handoff summary, and the most recent messages are kept as they are. After compaction, the session can continue seamlessly.

Compaction replaces only the **model view**; the original record on disk is untouched, so it is normal for `/context` to show "on disk but not carried by the model". See [compaction handoff](../internals/02-context/compaction-handoff.md) for more on the mechanism.

[Back to the scenario index](README.md)
