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

Press **Left (←) while the chat input is empty** to open Agents Management. Typing and cursor navigation in a nonempty input remain unchanged. Overview and Manager are selectable navigation items on the page; management does not add slash commands. The shell entry remains `rind agents`.

The page opens on a global Overview of sessions across teams (including members without sessions). Team navigation leads to Overview, Organization and Tasks tabs, with an adjacent detail pane on wide terminals and a compact single-column layout on narrow terminals. Select with Up/Down, `j/k`, mouse clicks or the wheel, then press Enter. `g/G` jumps to the first or last item and `Ctrl-U/Ctrl-D` pages through a list. Left/Esc returns to team navigation; Esc there returns to the original conversation. Tab or `1/2/3` switches the three team tabs. Right folds/unfolds a selected organization branch. Enter on a member opens its Session list; Enter on a Session joins or resumes it in that member's workspace. The selected object remains selected across live updates.

- **Create team** and **Add member** are selectable rows. Adding offers an existing folder, new workspace or Git worktree. Forms reuse the ordinary editor: paste, cursor movement, undo and multiline text all work; Tab/Shift+Tab changes fields, Enter advances or saves. Failed operations retain the entered values.
- **Manager** opens its dedicated, restricted conversation. The member Session list merges recorded history with live activity, preserving the original Team or independent scope. R refreshes historical entries; live states update through subscriptions. New conversation starts a fresh Session. Space opens context actions: assign work, edit responsibility, change a supervisor, add a direct report, choose the main agent, remove membership, or reconcile an unknown run. Destructive actions use an explicit confirmation with Cancel selected initially.
- **Task actions** offer delivery, notes/answers, queue priority, start/retry, cancellation and run recovery. A queued task explains whether it waits for a busy workspace, an unconfirmed run or an explicit start. High/normal/low priority orders only waiting work and never interrupts a live run.
- **Team briefing**, in the Team Overview tab, summarizes decisions needing the user, active work, members being waited on and delivered results. Delivery details include evidence, published files, notes and timestamped execution history. R refreshes an open briefing or delivery; task actions refresh its details after changes.
- `/` searches within the member/task list; F opens a selectable status filter. N creates a team. These are page shortcuts, not chat slash commands. All primary actions are also selectable with arrows and Enter.

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

The UI follows the empty-prompt Left entry, identity-stable selection and selected-row details in Codex `codex-rs/tui/src/app/agents_overview_view.rs` and `bottom_pane/chat_composer.rs`. Crush `internal/ui/dialog/sessions.go`, `inline_editor.go` and `model/sidebar.go` informed scoped dialogs, editable fields, persistent keyboard help and width-dependent layout. This implementation reuses Rind's TUI, line editor, choice selector, composer cursor calculation and theme, without adding another terminal framework.

Orca's `docs/reference/agent-status-store.md` informed the single status projection in the management package: runtime host facts take precedence, waiting for children is distinct from human action, and every surface receives the same summary. Paperclip's `doc/SPEC-implementation.md` informed queue ordering, explicit cancellation and actionable blockers. Task notes and run records provide the activity trail without a second activity database, company model or permissions framework.

## Shared Runtime

Managed Rind conversations and background tasks share one local execution host under `RIND_HOME/runtime`. The host uses the existing Runtime JSONL protocol and a private local endpoint. It owns the Worker independently of any CLI window. Existing unregistered Rind, gateway and WebSocket entry paths remain available.

The `rind-runtime-client` package owns transport and hosting; it has no Team dependency. `session/open` is a local-host operation that validates the requested workspace, creates or resumes a Session, and installs its external tool configuration. Ordinary WebSocket clients cannot inject this configuration. Session containers, model requests, workspaces, tool grants, questions and cancellation remain isolated. Shared immutable services are reused; idle execution containers are released.

One Session has one active prompt request. Additional windows can observe it, steer/queue input through the existing Runtime controls, or answer a pending question once. Detaching a CLI does not stop the execution. Returning to it restores history and the live turn without creating a second run. A lost host produces Unconfirmed state; reopen the session to reconnect and inspect before retrying uncertain work. The Runtime itself remains a persistent background service; stopping management does not shut down unrelated direct sessions.

Examples:

```sh
rind agents team reports-to product frontend engineering
rind agents sessions frontend --json
rind agents open product/frontend --session <runtime-session-id>
```

Session history currently lists the most recent 100 saved conversations per workspace, together with registered live Sessions. Cross-Team history keeps its original scope; opening it never silently assigns that history to the currently selected Team. LLM tracing is host-wide: set `RIND_TRACE_LLM=1` before starting the host; per-window `--trace-llm` is rejected rather than silently ignored. Shared history is stored in `RIND_HOME/sessions`; use `RIND_HOME` to select another installation rather than a custom `--session-dir`. The first adapter remains Rind.
