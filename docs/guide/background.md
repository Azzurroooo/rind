# Let commands that never finish keep running

English | [简体中文](background.zh-CN.md)

Goal: work that cannot finish in one go — test suites, builds, migrations — should neither jam the session nor be left with nobody watching once it finishes.

## It moves to the background on its own

Console tools (`bash`) only wait **10 seconds** by default (`yield_time_ms`, which you can ask the model to adjust in natural language, with an upper limit of 60 seconds). If that window expires, the command is not killed: it moves to the background and keeps running, and the result returned to the model carries a `task_id` and a status. The turn ends there, and the input box is immediately usable again.

`notify` decides how completion is announced:

| Value | Meaning |
| --- | --- |
| `on_exit` (default) | When the task ends, the result is delivered back to an idle session and the continuation starts automatically; no need to keep asking |
| `manual` | For services and watch-like long-lived processes: no automatic continuation, read the output explicitly when you need it |

## Watching progress with Ctrl+B

**Ctrl+B** opens the background monitor:

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a task |
| `c` | Cancel the task |
| `r` | Release the current wait (does not kill the process) |
| Esc | Close the monitor (background tasks are unaffected) |

Closing it only hides it; the work is still running. These console tasks are not the same thing as the tasks inside a Team; for the latter, see [Delegate the work to a Team](teams.md).

## Letting the model take over for you

The model can keep operating on them with the `task_control` tool: list tasks, read output (bounded), wait for a limited time, cancel. So asking something like "are the tests done yet?" works directly — it goes and reads the output instead of blindly re-running.

## Goals that span turns

Some work is more than "a single command": it is a goal that continues over multiple turns (across compaction, across restarts). Use `/goal`:

```text
/goal                    show the current goal
/goal <one-line goal>    set / update the goal
/goal pause | resume     pause / resume
/goal clear              clear
```

A goal carries checkpoints, progress is evaluated when a turn ends, and completion requires evidence. It and background commands are two separate mechanisms: one is **process-level** work, the other is **task-level** direction.

[Back to the scenario index](README.md)
