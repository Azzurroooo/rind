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

Press **Left (←) while the chat input is empty** to open Agents Management; see [Back, leave and stop](#back-leave-and-stop) for how to get out again. A nonempty input keeps its normal editing behavior. Management adds no slash commands; the shell entry remains `rind agents`. The page is keyboard-only and never captures the mouse, so the terminal's own selection and scrollback keep working.

### Layout

```text
 Agents › Product › Organization                        ! 1 need you  ● 1 working  ● connected
  ! Inbox              1│Product · 4 members · leader Lead
  ◆ Manager             │ Organization   Tasks 1
  ◇ Independent         │
─ TEAMS · 1 ────────────│  + Add member                                   │ API
› ! Product          ! 1│  Lead          Leader                 ● working │ Backend · reports to Lead
  + New team            │  ├─ ● Plan the release          Working     now │
                        │  ├─ API        Backend            ! needs you   │ ! Needs you
                        │  │  ├─ ! Fix the login          Needs input  2m │
                        │  │  └─ DB      Database                   idle │ Workspace
                        │  └─ Web        Frontend               ○ 1 open │ ~/work/api
 ✓ Member added
 enter conversations  c new chat  t assign task  a add report  space actions  z fold  ? help  esc back
```

- **Header** — breadcrumb on the left; attention, activity and connection on the right.
- **Sidebar** — Inbox, Manager, Independent, Background, every team (with its most urgent status) and New team. Below 84 columns the sidebar becomes its own screen: Esc shows it, Enter opens the selection.
- **Main view** — the selected page. A team has two views, Organization and Tasks (Tab, `1`, `2`).
- **Detail pane** — what the selected row is and what Enter does; beside the list from 90 columns, below it on tall narrow terminals.
- **Status line** — the result of the last action (✓, ✕ or •), which clears after a few seconds; a spinner while an action runs.
- **Key bar** — only the keys valid for the selected row, most important first. `?` and `esc` are always kept and hints are dropped whole, never cut in half.

### Organization

The reporting tree, rooted at the leader; members without a supervisor report to the leader. Members and their conversations are drawn differently so their levels never blur:

- A **member** row is the name in bold, its role in an aligned column, and a summary on the right in words about the person: `● working`, `! needs you`, `○ 1 open`, or a dim `idle`. A member has no status glyph of its own in the tree.
- A **conversation** sits under its member, inside the tree guides, with its own glyph, status and age: `├─ ● Plan the release   Working   now`. The three most urgent are shown inline; the rest collapse into a "+N more" row.

Statuses use one glyph set everywhere: `!` Needs input, `?` Unconfirmed, `●` Working, `…` Waiting on members, `◦` Queued, `○` Open, `✓` Done, `·` Idle. A member's summary also counts its open tasks (`○ 1 open · 2 tasks`).

### What a status means

The shared Runtime hosts the conversation of every interactive Rind window and every task, and it keeps a small live table: for each conversation its folder, whether a turn is running or waiting for an answer, and how many windows show it. The table is updated from requests and events the Runtime already handles, so nothing polls, and it is pushed to the Agents page once per burst of changes.

| Status | Meaning |
| --- | --- |
| `●` Working | A turn or task is running, whether or not any window shows it. |
| `!` Needs input | It stopped to ask a question, or a task is blocked on you. |
| `?` Unconfirmed | A run's outcome could not be confirmed after a service was lost; confirm the old process stopped before retrying. |
| `○` Open | Nothing runs, and at least one Rind window shows it. |
| `·` Idle | Nothing runs and no window shows it; the time is its last activity. |

Closing a window turns an open conversation idle; it never stops a running turn. A new conversation with no message yet is not listed anywhere, except in the window that has it open.

### Several windows on one conversation

Any number of Rind windows can show the same conversation; the shared Runtime keeps them in step.

- When the agent asks a question, every window shows it. Answering in one closes it in the others, which show the answer as "answered in another window".
- `rind send --session <id> "…"` goes to the window that most recently showed the conversation, as if typed there. With no window open, a turn that is still running takes it as a follow-up. An idle conversation nobody has open is refused rather than started without the tools and scope its window configured.
- Every page opens a conversation the same way, by its session and its folder (or team member, or Manager), so Background, Independent and the team pages behave alike. A conversation's folder comes from the Runtime first, so one without saved history can still be opened. When a conversation window cannot start, the Agents page shows why.

**Left always moves up one level** — from a conversation to its member, from a member to the sidebar — and never collapses anything, so leaving the tree takes at most two presses. Right expands a collapsed member or opens it. `z` folds the selected branch and `Z` folds or unfolds all; a folded member shows `▸`, the number of hidden rows and the most urgent status hidden inside. Lists keep two rows of context around the selection while scrolling. `/` searches and `f` filters by status; matches keep their ancestors visible, and Esc clears them.

Only conversations attached to the team are listed; a member folder's other conversations are on the Independent page. The service enforces this through `listSessions { teamId }`, so `rind agents sessions <team>` returns the same set.

Enter on a member opens its page: every conversation it has in this team, newest and most urgent first, with **New conversation** on top. Enter on a conversation joins it in the member's workspace. Contextual keys act on the selected member: `c` new conversation, `t` assign a task, `a` add a member reporting to it, `e` edit role and responsibility, Space for all actions (change supervisor, make leader, resolve an unconfirmed run, remove from team).

### Tasks

Tasks are grouped by what you do first: Needs you, In progress, Queued, Waiting on members, Delivered and Cancelled. Each row shows the owner and priority; wide terminals add the blocker, queue reason or delivery summary. Enter opens the delivery view: outcome, evidence, artifacts, notes and recent runs; there Space opens task actions (answer or note, start or retry, queue priority, stop or cancel, resolve an unconfirmed run) and `r` refreshes. Priority only reorders waiting work; it never interrupts a running task.

### Inbox, Manager and Independent

The **Inbox** collects everything waiting on you across teams: blocked tasks, tasks that need attention, runs whose stop could not be confirmed, running tasks that stopped to ask a question ("Task asks: …") and team conversations waiting for an answer. Enter answers, resolves or joins. Below that, **Recently delivered** lists the newest finished tasks with their summary; Enter opens the delivery. Teams themselves are only in the sidebar.

**Manager** lists Manager conversations and starts new ones in its restricted workspace.

**Independent** shows every conversation that belongs to no team, grouped by folder, live. A conversation outside a team is a plain session: it never becomes an agent; only team members are bound to a folder. Folders that are team members show their team; other folders appear under their basename. Running and open folders sort first. Each folder shows its three most urgent conversations and a "+N more" row; Enter on the folder (or the row) opens the folder's page with every conversation grouped as Active, Today, This week and Earlier, searchable with `/`. `[` and `]` jump between folders, `z` / `Z` fold them, and `c` starts a new conversation in the selected folder. Enter on a conversation continues it in its folder, outside every team. History is read through `listSessions { independent: true }` and refreshed every 30 seconds; live state arrives as it changes.

### Adding members

**Add member** offers three sources; each says who the new member will report to, and the first member of a team becomes its leader.

- **Existing folder** — `Folder` accepts an absolute path, `~/…` or a path relative to where you opened Rind. Matching folders are listed as you type: Tab completes like a shell, ↑↓ and Enter pick a folder, Esc hides the list. Below the input a live check shows the resolved path and whether it is a Git repository, or why it cannot be used. `Name` defaults to the folder name.
- **New empty workspace** — `Folder name` previews the full path inside the team's workspace area and rejects names with slashes or ones that already exist.
- **New Git worktree** — asked in the order you think about it: `Repository` (must be a Git repository), `New branch`, `Folder name` (derived from the branch) and `Start from` (HEAD by default).

Every source asks for the same two optional fields:

- **Role** — a short job title shown beside the name in the tree, e.g. Reviewer or Frontend. The leader also sees it when choosing who to delegate to.
- **Responsibility** — what the member is in charge of, in a sentence. It is added to the member's instructions on every team task.

### Back, leave and stop

Rind is not one process: agents, tasks and the shared Runtime run in the background, and windows only watch them. So there are three different ways to get out, and none of them silently does another's job.

| You want to | Do | What happens |
| --- | --- | --- |
| Go back one level | `esc` on the Agents page · `←` on an empty input in a conversation | The page returns to the conversation that opened it; a conversation opened from Agents returns to the same Agents page. |
| Leave Rind | `ctrl+c` twice when idle · `/exit` | Every Rind window closes. Agents, tasks and the shared Runtime **keep running**; the last window says how many are still working. |
| Stop everything | Agents › **Background** › Stop all agents and leave Rind · `rind agents stop --all` | Managed tasks end as cancelled, running conversation turns are cancelled, then the shared Runtime and the management service stop and every Rind window closes. Teams, tasks and conversation history are kept. |

`ctrl+c` always handles the most immediate thing first:

1. While a turn runs, it interrupts that turn. A second press during the interrupt force-closes the window.
2. With text in the input, it clears the text.
3. When idle, the first press shows `ctrl+c again to leave Rind · agents keep running` for two seconds. A second press leaves; any other key (or `esc` on the Agents page) cancels. Without a terminal (scripts, pipes) there is no hint to see, so a single interrupt leaves.

Conversations opened from Agents never nest. When you move to Agents or to another conversation from inside one, it hands the move back to the window that opened it and closes. The handoff goes through a private file named by `RIND_AGENTS_HANDOFF`; the window removes that variable from its environment at startup, so services and tools it starts never inherit it. There is at most one level, and leaving from anywhere closes everything. A conversation in an unregistered folder runs in the window's own worker; while it is working, moving away is refused instead of killing it.

The **Background** page shows what keeps running after you leave. **Running now** lists every running turn and task in the shared Runtime, from any Rind window, in a team or not, with where it runs and for how long. Below are runs whose stop could not be confirmed, and both background services with their process ID and uptime. Enter on a service shows its recent log; when a newer Rind is installed, the management service offers **Restart to load the update**, which keeps every conversation running while windows reconnect. The shared Runtime keeps old code while windows use it and updates once they are all closed. Stop is a quiet `[ Stop all agents… ]` button at the end, also on `S`. Its dialog selects Cancel first, lists what is running and says what is kept. Its single action is **Stop all agents and leave Rind**. Every open conversation depends on these services, so stopping always closes the windows too, rather than leaving them on a stopped Runtime.

`rind agents stop` stops both background services, but only when nothing is running; otherwise it lists the running work and exits with status 1. `--all` also stops running agents. It never starts a service just to stop it. Conversations still open elsewhere notice the stop, reattach if the service comes back on its own, and otherwise continue untracked; nothing restarts a service you stopped except opening Agents or pressing `r`.

### Updates and background services

The background services run detached, so after you update Rind they would otherwise keep running the old code. Each one reports a fingerprint of its code: `serviceInfo` for the management service and `runtime/info` for the shared Runtime, which answers without starting a worker. Every client compares that fingerprint with the code on disk when it connects:

- **Idle and outdated:** the service is stopped and replaced transparently.
- **Running agents:** the service is kept, so no work is interrupted. The Agents page says an update is waiting, and the Background page marks the service. Once its agents finish, the next connection replaces it, or you can stop it from Background.

A fingerprint covers file names relative to the install and file contents only, so the same code installed elsewhere, spelled with another drive-letter case, or reinstalled matches. Each service fingerprints the code it loaded at startup. A Runtime that is still observed by the management service or used by a conversation is never replaced underneath it; when the host is replaced while idle, the management service reattaches to the new one.

Services started by a Rind from before fingerprints cannot be asked to stop. Clients find their process by script and data folder, check through the service's own snapshot that nothing is running, then end it so a current one starts. `rind agents stop` uses the same path, and with `--all` it does so even while agents run.

This follows the rule used by crush (`restartIfStale`, refused while busy) and orca (a stale daemon is preserved while it owns live sessions).

### Dialogs and forms

Choice dialogs number their options: `1`–`9` pick directly, and the letter shown at the right runs the same action as the page shortcut. Destructive dialogs are framed in red, preselect Cancel (`n`), and require `y` or an explicit selection. Dialogs open at a fixed position, so they do not jump while you type. Forms reuse the chat editor, so paste, cursor movement, undo and Shift+Enter work. Enter moves to the next field and saves on the last one; Shift+Tab goes back, and Tab moves on (in folder fields it completes). A field with a problem cannot be left, and a failed save keeps what you typed and shows the error inside the dialog. Keys typed while a save is running are replayed afterwards, unless the save opened a new dialog.

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

History is bounded so writes stay fast: the newest 512 request receipts (used only for retries), the latest finished run of each conversation and the last 10 runs of each task are kept; active and unconfirmed runs are never pruned. The service refuses to silently rebuild a corrupt journal. An incomplete final line is discarded; an earlier malformed record or sequence gap stops startup and leaves the files for repair. On management restart, active runs first become `unknown`; shared Sessions are reconciled against the still-running Runtime. Queued dispatch markers are cleared. A crashed Runtime is never automatically replayed as a new execution. Resolve an unknown run only after confirming its old process has stopped, then explicitly retry the task. Published artifacts are copied into the user-private Team/Task delivery directory and checked against the task owner workspace.

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
