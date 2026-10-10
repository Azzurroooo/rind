# Keyboard shortcuts and commands at a glance

English | [简体中文](cheatsheet.zh-CN.md)

The CLI's keys and commands on a single screen. Come back to this page when you forget.

## Keys

| Key | Scenario | Action |
| --- | --- | --- |
| Enter | Anywhere | Send input |
| Shift+Enter / Ctrl+Enter | Writing a multi-line prompt | Newline |
| Tab | Turn in progress | Queue input as a follow-up (sent automatically once the turn ends) |
| Enter | Turn in progress | Sent as steering, takes effect before the next sample |
| Alt+↑ | Pending follow-up | Recall into the editor |
| Alt+↓ | Pending steering | Recall into the editor |
| Alt+→ | Pending follow-up | Promote to steering |
| Ctrl+C | Turn running / idle (press twice within 2s) / with unsent text | Interrupt the turn (again for a hard stop) / quit / clear the input first |
| Ctrl+O | Anywhere | Expand/collapse tool output |
| Ctrl+T | Anywhere | Cycle reasoning effort |
| Ctrl+B | Anywhere | Open/close the background task monitor |
| ↑ / ↓ | Input box | Prompt history |
| Esc | Slash menu / monitor | Closes the current menu or monitor (the menu first, when one is open) |
| ← | Empty input box | Open Agents Management |

## Slash commands

| Command | Purpose |
| --- | --- |
| `/help [command]`, `?` | Command list and usage |
| `/login [provider]` | Connect a model provider |
| `/logout [provider]` | Remove stored credentials |
| `/model`, `/model set <model>` | Picker menu / specify a model directly |
| `/effort [low \| medium \| high \| xhigh \| max]` | Reasoning effort |
| `/sessions [limit]` | List recent sessions |
| `/rename <name>`, `/rename --reset` | Name the session |
| `/fork` | Fork the session from a message |
| `/compact` | Compact the current context |
| `/context` | Context composition and usage panel |
| `/goal [pause \| resume \| clear \| <goal>]` | Persistent Goal |
| `/skill` | Skills, where they come from, and load problems |
| `/import` | Choose which Claude and Codex skills the conversation reads |
| `/init [project\|user]` | Draft RIND.md |
| `/status` | Session and connection status |
| `/theme [name]` | Switch color scheme |
| `/tour [page]` | Interactive feature tour |
| `/exit` (`/quit`) | Quit |

## Subcommands

| Command | Purpose |
| --- | --- |
| `rind [--team <id> \| --standalone] [--session <id>]` | Interactive session; `--team` scopes sessions to a shared workspace, `--standalone` leaves the team, `--session` resumes a saved session |
| `rind run --prompt <text> [--dir <path>] [--session <id>]` | One-shot run, answer to stdout |
| `rind send --session <id> "<prompt>"` | Deliver input to the target session |
| `rind config set model\|effort <value> --folder [dir] [--connection <id>]`, `rind config unset ...` | Directory-level defaults |
| `rind tour [page]` | Simulated demo tour |
| `rind agents ...` | Team management, see [Hand the work to a team](teams.md) |
| `rind --help`, `rind --version` | Help and version |

## Syntactic sugar

| Form | Action |
| --- | --- |
| `$skill-name` | Reference a Skill from a prompt |
| `/skill:skill-name` | The whole message is a Skill invocation |
| `uploads/xxx.png` | Have the turn bring this image (relative to the workspace) |

[Back to the scenario index](README.md)
