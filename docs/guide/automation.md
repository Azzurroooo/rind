# Use Rind without sitting at the prompt

English | [简体中文](automation.zh-CN.md)

Goal: get an answer, or drop a line into a running session, without opening the interactive interface.

## Get one answer: rind run

```bash
rind run --prompt "Check the current diff for breaking API changes" --dir /path/to/project > review.md
```

The behavior contract, before you write scripts:

| Contract | Description |
| --- | --- |
| The final answer goes to **stdout** | Redirect it directly; everything else goes to stderr |
| Progress and diagnostics go to **stderr** | stdout stays clean and pipeable |
| A run summary under `logs/` | Markdown, written in the launch directory |
| User questions are disabled | When a question is needed it simply fails, without hanging on input |
| Failures return a non-zero exit code | Usage errors exit with code 2 |

By default it waits for this task **and any necessary continuations**: background tasks started this turn continue on their own once they finish, until a final answer is produced—so a one-shot chain like "run the tests and summarize the failures" needs no polling from you.

Continue an existing session with `--session <id>`.

## Drop a line into a running session: rind send

```bash
rind send --session 20260825_101530_ab12cd34 "The integration tests failed; investigate before continuing."
```

Delivery semantics: the window that most recently showed this session handles it like manual input—idle, it starts a turn; busy, it goes in as steering; with no window open, a still-running turn takes it as a follow-up. Successful delivery is confirmed immediately, but that only means "received", not that the task is done.

Find the session ID in the target CLI's startup banner or `/status`.

## Configure defaults: rind config

```bash
rind config set model <model-id> --folder /path/to/project
rind config unset effort --folder /path/to/project
```

Pin the model and reasoning effort for new sessions per directory, no interaction needed. See [Let the project remember defaults](models.md#let-the-project-remember-defaults).

## Demos without an API key: rind tour

`rind tour [page]` plays back a simulated session: real CLI rendering, no model calls, no file changes. Useful for writing docs, recording screens, and demoing to colleagues.

[Back to the scenario index](README.md)
