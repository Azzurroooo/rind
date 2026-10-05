# Agents Management

Agents Management is the local control plane for persistent workers. It is an independent TypeScript package; Rind is only its first execution adapter. A future Codex or Claude Code adapter uses the same task and run contract.

## Start

Build the service once, then use the CLI from this repository:

```sh
npm --prefix agent-management install
npm --prefix agent-management test
npm --prefix frontend-cli install
npm --prefix frontend-cli run build
node frontend-cli/bin/rind.js agents list
```

The service starts on demand under `RIND_HOME/agents-management`. Its state is an atomic JSONL journal and snapshot. `manager/` is the Manager's private workspace; `state/` contains credentials, the endpoint and published artifacts. Keep `RIND_HOME` user-private.

## Team workflow

```sh
rind agents team create product
rind agents team add product /work/project --position Builder
rind agents team add product /work/reviewer --position Reviewer
rind agents team leader product project
rind agents task product reviewer "Review the current change and report evidence."
rind agents list --json
```

Every member is an existing canonical folder. Teams are registry relationships, so a folder can join several teams. If it already belongs to another team, the interactive page recommends a copy; `--share` is the explicit shared-folder choice. Shared workspaces serialize writes. A Git worktree gets a separate registered member and can run in parallel:

```sh
rind agents team worktree product feature-search /work/project feature/search
```

The first member is not silently granted extra file access: it is simply the initial leader. Each configured team has one main agent and a tree of reporting relationships. Members delegate to their direct reports and see tasks in their subtree. Every member can create and register a new direct report below the team creation root. User and Manager can arrange the entire tree. Cycles are rejected, and direct reports must be reassigned before removing their supervisor. A task is `done` only after a valid report and confirmed execution completion. A blocker must name `user` or a current member and state the action needed. Reports wake the original delegating task, recursively through all levels; waiting for grandchildren does not complete the intermediate task. Moving a member does not rewrite existing task ownership or parent tasks. Existing flat teams remain valid: an omitted supervisor means the main agent.

The folder basename is its initial agent name; position is a separate display label. Use IDs when names are ambiguous. `team create <name> --root <existing-directory>` sets the boundary for new workspaces. Agent hints and Skill references can be supplied through `registerAgent`; a reference is a normal project/user Skill name or an absolute `SKILL.md` path. Imported local legacy Skills retain their original reference directories.

## CLI surface

Press **Left (←) while the chat input is empty** to open Agents Management. A nonempty input keeps its normal editing behavior. Management adds no slash commands; the shell entry remains `rind agents`. The page is keyboard-only and never captures the mouse, so the terminal's own selection and scrollback keep working.

### Layout

```text
 Agents › Product › Organization                      ! 2 need you  ● 1 working  ● connected
  ! Inbox              2│Product · 4 members · leader Lead
  ◆ Manager             │ Organization   Tasks 1
─ TEAMS · 1 ────────────│
› ! Product          ! 2│  + Add member                          │ API
  + New team            │  ● Lead · Leader          Working      │ Backend · reports to Lead
                        │  ● ├─ Plan the release    Working  now │
                        │› ! ├─ API · Backend       Needs input  │ ! Needs input
                        │  ! │  ├─ Fix the login    Needs input  │
                        │  ○ │  └─ DB               Ready        │ Workspace
                        │  · └─ Web                 Inactive     │ /work/api
 ✓ Member added
 enter conversations  c new chat  t assign task  a add report  space actions  ? help  esc back
```

- **Header** — breadcrumb on the left; attention, activity and connection on the right.
- **Sidebar** — Inbox, Manager, every team (with its most urgent status) and New team. Below 84 columns the sidebar becomes its own screen: Esc shows it, Enter opens the selection.
- **Main view** — the selected page. A team has two views, Organization and Tasks (Tab, `1`, `2`).
- **Detail pane** — what the selected row is and what Enter does; beside the list on wide terminals, below it on tall narrow ones.
- **Status line** — the result of the last action (✓, ✕ or •), which clears after a few seconds; a spinner while an action runs.
- **Key bar** — only the keys valid for the selected row, most important first. `?` and `esc` are always kept and hints are dropped whole, never cut in half.

### Organization

The reporting tree, rooted at the leader; members without a supervisor report to the leader. **Conversations are nested under their member** with their status and how recently they were active. The three most urgent are shown inline and the rest collapse into a "+N more" row. Statuses use one glyph set everywhere: `!` Needs input, `?` Unconfirmed, `●` Working, `…` Waiting on members, `◦` Queued, `○` Ready, `✓` Done, `·` Inactive.

Left collapses a member's branch, or moves to its parent; Right expands. A collapsed member shows the most urgent status hidden inside it and the number of hidden rows. `/` searches and `f` filters by status; matches keep their ancestors visible and ignore collapsed branches, and Esc clears them.

Only conversations attached to the team are listed. A member folder's independent conversations never appear here. The service enforces this through `listSessions { teamId }`, so `rind agents sessions <team>` returns the same set.

Enter on a member opens its page: every conversation it has in this team, newest and most urgent first, with **New conversation** on top. Enter on a conversation joins it in the member's workspace. Contextual keys act on the selected member: `c` new conversation, `t` assign a task, `a` add a member reporting to it, `e` edit role and responsibility, Space for all actions (change supervisor, make leader, resolve an unconfirmed run, remove from team).

### Tasks

Tasks are grouped by what you do first: Needs you, In progress, Queued, Waiting on members, Delivered and Cancelled. Each row shows the owner and priority. On wide terminals it also shows the blocker, queue reason or delivery summary.

Enter opens the delivery view: outcome, evidence, artifacts, notes and run history. From there, Space opens task actions and `r` refreshes. Task actions:

- answer the blocker or add a note
- start now or retry
- queue priority
- stop or cancel
- resolve an unconfirmed run

Priority only reorders waiting work; it never interrupts a running task.

### Inbox and Manager

The **Inbox** collects everything waiting on you, across all teams:

- blocked tasks or tasks that need attention
- runs whose stop could not be confirmed
- team conversations that asked a question

Enter answers, resolves or joins the selected item. Below that, every team is listed with its member and activity counts. **Manager** lists Manager conversations and starts new ones in its restricted workspace.

### Dialogs and forms

Choice dialogs number their options: `1`–`9` pick directly, and the letter shown at the right runs the same action as the page shortcut. Destructive dialogs are framed in red, preselect Cancel (`n`), and require `y` or an explicit selection. Forms reuse the chat editor, so paste, cursor movement, undo and Shift+Enter work. Tab moves between fields, as do ↑↓ on single-line fields. Enter moves to the next field and saves on the last one. A failed save keeps what you typed and shows the error inside the dialog. Creating a team flows straight into adding its first member, who becomes the leader. Every add-member step says who the new member will report to.

Non-TTY commands support `--json`. Use `rind agents priority <task> high|normal|low`, `cancel <task>`, `show <task>`, `note <task> <text> --answer`, `start <task>`, `stop <run>` and `resolve <run> --confirm-stopped`. `rind agents import <legacy-root>` previews old `.aiteam` files; add `--confirm` after reviewing the preview. Import never edits legacy files.

When a workspace belongs to multiple teams, a TTY asks which scope to attach. Non-TTY requires `--team <id>` or `--standalone`. Direct conversations are observed as runs, but their private messages are not broadcast. If the management service disconnects, it reconciles with the Runtime replay before restoring activity; an unconfirmed run remains reserved until a human confirms it stopped.

Each managed Session keeps one management scope; the shared Worker hosts many isolated Sessions. `/sessions` and `/fork` open the selected history in another CLI connected to the same shared Runtime, preserving the current conversation when you return; a fork also prefills its selected user message. Open another member through the Agents page or resume with `rind --session <runtime-id> --team <team-id>`. A conversation from another workspace or team cannot reuse the current scope. Unregistered ordinary Rind retains its existing session controls. The first adapter is Rind; external Codex/Claude processes are not automatically observed.

## Boundaries

The service owns authorization, persistence, scheduling, workspace locks, reports and subscriptions. The adapter connects to the shared Runtime and translates lifecycle events. The management service observes session status from the execution host; it never treats closing a CLI as execution completion. Python receives a generic external tool configuration per Session and an optional list of absolute Skill files; it has no Team model. Model credentials cannot publish lifecycle facts, and host credentials cannot call management mutations. Manager sessions receive only the management tool and cannot browse member files.

The old Python Team discovery, `agent_create` and in-Worker `delegate` paths are removed. The read-only importer is the sole legacy bridge. `rind-runtime-client/` is shared by the CLI and adapter so the transport is not duplicated.

## Distribution

The source repository's external Windows distribution can stage the new components with:

```sh
node agent-management/stage.mjs C:/tmp/rind-cli-stage
```

The destination must not exist. The script builds TypeScript, copies the CLI, service, shared runtime client and YAML dependency, and writes package metadata from `agent/version.py`. A packaged Worker is supplied by the normal runtime distribution, or selected with `RIND_RUNTIME_PATH`.

## Recovery

The service refuses to silently rebuild a corrupt journal. An incomplete final line is discarded; an earlier malformed record or sequence gap stops startup and leaves the files for repair. On management restart, active runs first become `unknown`; shared Sessions are reconciled against the still-running Runtime. Queued dispatch markers are cleared. A crashed Runtime is never automatically replayed as a new execution. Resolve an unknown run only after confirming its old process has stopped, then explicitly retry the task. Published artifacts are copied into the user-private Team/Task delivery directory and checked against the task owner workspace.

If a process dies between creating a folder/worktree and registering it, an existing target is never overwritten on retry. Inspect and register the resulting folder through `team add`, or choose a different name. Repository changes and registry commits are separate local operations, not a filesystem transaction.


## Interaction and scheduling references

The page reuses Rind's TUI engine, line editor, composer cursor maths and theme; it adds no terminal framework.

- Codex `codex-rs/tui` (`resume_picker.rs`, `footer.rs`, `key_hint.rs`, `list_selection_view.rs`): the key-bold/label-dim hint bar that drops whole hints by priority, numbered choice shortcuts, compact relative time and identity-stable selection.
- Crush `internal/ui` (`dialog/sessions.go`, `dialog/common.go`, `model/status.go`): context-dependent short help with a full `?` overlay, in-place destructive confirmation with the safe choice preselected, and a typed status message that expires.
- Orca (`docs/reference/agent-status-store.md`, `worktree-status.ts`, `smart-attention.ts`): one status projection, the worst-status roll-up for collapsed branches and teams, attention-first ordering (needs you, unconfirmed, working, idle) and "unconfirmed" as missing evidence rather than failure.
- Paperclip (`ui/src/pages/Agents.tsx` `filterOrgTree`, `lib/attention.ts`, `doc/execution-semantics.md`): a filtered org tree that keeps matching branches' ancestors, one inbox of what needs the human, queue ordering, explicit cancellation and actionable blockers.

Task notes and run records provide the activity trail without a second activity database, company model or permissions framework.

## Shared Runtime

Managed Rind conversations and background tasks share one local execution host under `RIND_HOME/runtime`. The host uses the existing Runtime JSONL protocol and a private local endpoint. It owns the Worker independently of any CLI window. Existing unregistered Rind, gateway and WebSocket entry paths remain available.

The `rind-runtime-client` package owns transport and hosting; it has no Team dependency. `session/open` is a local-host operation that validates the requested workspace, creates or resumes a Session, and installs its external tool configuration. Ordinary WebSocket clients cannot inject this configuration. Session containers, model requests, workspaces, tool grants, questions and cancellation remain isolated. Shared immutable services are reused; idle execution containers are released.

One Session has one active prompt request. Additional windows can observe it, steer/queue input through the existing Runtime controls, or answer a pending question once. Detaching a CLI does not stop the execution. Returning to it restores history and the live turn without creating a second run. A lost host produces Unconfirmed state; reopen the session to reconnect and inspect before retrying uncertain work. The Runtime itself remains a persistent background service; stopping management does not shut down unrelated direct sessions.

Examples:

```sh
rind agents team reports-to product frontend engineering
rind agents sessions product/frontend --json
rind agents open product/frontend --session <runtime-session-id>
```

`rind agents sessions <team>[/<agent>]` lists conversations registered to that team (up to 100 saved conversations per workspace plus registered live Sessions); `rind agents sessions manager` lists Manager history. A conversation keeps the scope it was created with; opening a team never adopts independent or other-team history. LLM tracing is host-wide: set `RIND_TRACE_LLM=1` before starting the host; per-window `--trace-llm` is rejected rather than silently ignored. Shared history is stored in `RIND_HOME/sessions`; use `RIND_HOME` to select another installation rather than a custom `--session-dir`. The first adapter remains Rind.
