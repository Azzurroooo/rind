# Getting work done in Rind: a CLI guide organized by scenario

English | [简体中文](README.zh-CN.md)

These docs are not about architecture; they are only about **how to get things done with the CLI**. Each page maps to a real scenario: it starts from "I want to ...", not from a feature.

Architecture and implementation details live in [internals](../internals/README.md); this is onboarding and daily usage.

## Pick a scenario

| What you want to do | Read this page |
| --- | --- |
| Just installed, and want to watch it finish a task | [Get your first task done](first-task.md) |
| The task is half done, and you want to change direction, queue, or interrupt | [Steer the work back on track](steer-the-work.md) |
| Connect a model, or switch between several models | [Get Rind to use the model you specify](models.md) |
| A command will not finish soon, and you want it to keep going in the background | [Let unfinished commands keep going](background.md) |
| Something was left unfinished, and you are coming back to continue | [Come back and keep working](resume.md) |
| Pin down project background and Skills | [Load the project into Rind](project-context.md) |
| One person is not enough, so hand work to a team | [Hand the work to a team](teams.md) |
| Not sitting at the terminal; let scripts drive Rind | [Use Rind without being at the terminal](automation.md) |
| Forgot a key or a command | [Keyboard shortcuts and command cheatsheet](cheatsheet.md) |

## Build intuition in three minutes

1. **Start**: `rind` runs inside the project directory; the session is only created when the first message is sent.
2. **Conversation**: Enter sends; during a turn, Enter is steering, Tab queues.
3. **Interrupt**: Ctrl+C interrupts the current turn; Ctrl+O expands tool output for details.
4. **Models**: `/login` connects a provider, `/model` picks a model, Ctrl+T switches the reasoning effort.
5. **Background**: console tools that exceed the wait window automatically move to the background; Ctrl+B shows progress.
6. **Scripts**: `rind run --prompt "..."` gets the final answer; `rind send --session <id> "..."` injects into a running session.

## Other entry points

The CLI is only one of Rind's Surfaces; the same core also has:

- **Desktop**: visually manage multiple projects, [architecture docs](../internals/07-surfaces/desktop.md).
- **Web / Mobile**: connect a resident Worker from a browser or a phone, [architecture docs](../internals/07-surfaces/web-and-mobile.md).
- **Messaging gateway**: Telegram, Discord, Slack, Lark, and other channels, [architecture docs](../internals/07-surfaces/gateway.md).

[Back to the docs entry](../README.md)
