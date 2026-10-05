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

The first member is not silently granted extra file access: it is simply the initial leader. Only a registered member can receive a task, and only a leader can assign child work. Leaders can create workspaces below their team creation root. A task is `done` only after a valid report and confirmed execution completion. A blocker must name `user` or a current member and state the action needed. Child reports wake the blocked leader automatically.

The folder basename is its initial agent name; position is a separate display label. Use IDs when names are ambiguous. `team create <name> --root <existing-directory>` sets the boundary for new workspaces. Agent hints and Skill references can be supplied through `registerAgent`; a reference is a normal project/user Skill name or an absolute `SKILL.md` path. Imported local legacy Skills retain their original reference directories.

## CLI surface

Press **Left (←) while the chat input is empty** to open Agents Management. Typing and cursor navigation in a nonempty input remain unchanged. Manager is the first selectable navigation item on the page; management does not add slash commands. The shell entry remains `rind agents`.

The page uses team navigation and a member/task list, with an adjacent detail pane on wide terminals and a compact single-column layout on narrow terminals. Select with Up/Down and Enter. Left/Esc returns to team navigation; Esc there returns to the original conversation. Tab switches members/tasks. The selected object remains selected across live updates.

- **Create team** and **Add member** are selectable rows. Adding offers an existing folder, new workspace or Git worktree. Forms reuse the ordinary editor: paste, cursor movement, undo and multiline text all work; Tab/Shift+Tab changes fields, Enter advances or saves. Failed operations retain the entered values.
- **Manager** opens its dedicated, restricted conversation. Enter on a member opens ordinary chat. Space opens context actions: assign work, edit responsibility, choose a leader, remove membership, or reconcile an unknown run. Destructive actions use an explicit confirmation with Cancel selected initially.
- **Task actions** offer delivery, notes/answers, queue priority, start/retry, cancellation and run recovery. A queued task explains whether it waits for a busy workspace, an unconfirmed run or an explicit start. High/normal/low priority orders only waiting work and never interrupts a live run.
- **Team briefing** summarizes decisions needing the user, active work, members being waited on and delivered results. Delivery details include evidence, published files, notes and timestamped execution history. R refreshes an open briefing or delivery; task actions refresh its details after changes.
- `/` searches within the member/task list; F opens a selectable status filter. N creates a team. These are page shortcuts, not chat slash commands. All primary actions are also selectable with arrows and Enter.

Non-TTY commands support `--json`. Use `rind agents priority <task> high|normal|low`, `cancel <task>`, `show <task>`, `note <task> <text> --answer`, `start <task>`, `stop <run>` and `resolve <run> --confirm-stopped`. `rind agents import <legacy-root>` previews old `.aiteam` files; add `--confirm` after reviewing the preview. Import never edits legacy files.

When a workspace belongs to multiple teams, a TTY asks which scope to attach. Non-TTY requires `--team <id>` or `--standalone`. Direct conversations are observed as runs, but their private messages are not broadcast. If the local service disconnects, the CLI reconnects and checks the Runtime replay before restoring activity; an unconfirmed run remains reserved until a human confirms it stopped.

An attached Worker keeps one management conversation scope. `/sessions` and `/fork` open the selected history in another managed process, preserving the current conversation when you return; a fork also prefills its selected user message. Open another member through the Agents page or resume with `rind --session <runtime-id> --team <team-id>`. A conversation from another workspace or team cannot reuse the current scope. Unregistered ordinary Rind retains its existing session controls. The first adapter is Rind; external Codex/Claude processes are not automatically observed.

## Boundaries

The service owns authorization, persistence, scheduling, workspace locks, reports and subscriptions. The adapter starts a Worker and translates only low-frequency lifecycle events. Python receives a generic external tool configuration and an optional list of absolute Skill files; it has no Team model. Model credentials cannot publish lifecycle facts, and host credentials cannot call management mutations. Manager sessions receive only the management tool and cannot browse member files.

The old Python Team discovery, `agent_create` and in-Worker `delegate` paths are removed. The read-only importer is the sole legacy bridge. `rind-runtime-client/` is shared by the CLI and adapter so the transport is not duplicated.

## Distribution

The source repository's external Windows distribution can stage the new components with:

```sh
node agent-management/stage.mjs C:/tmp/rind-cli-stage
```

The destination must not exist. The script builds TypeScript, copies the CLI, service, shared runtime client and YAML dependency, and writes package metadata from `agent/version.py`. A packaged Worker is supplied by the normal runtime distribution, or selected with `RIND_RUNTIME_PATH`.

## Recovery

The service refuses to silently rebuild a corrupt journal. An incomplete final line is discarded; an earlier malformed record or sequence gap stops startup and leaves the files for repair. On restart, active runs become `unknown` and queued dispatch markers are cleared. Resolve an unknown run only after confirming its old process has stopped, then explicitly retry the task. Published artifacts are copied into the user-private Team/Task delivery directory and checked against the task owner workspace.

If a process dies between creating a folder/worktree and registering it, an existing target is never overwritten on retry. Inspect and register the resulting folder through `team add`, or choose a different name. Repository changes and registry commits are separate local operations, not a filesystem transaction.


## Interaction and scheduling references

The UI follows the empty-prompt Left entry, identity-stable selection and selected-row details in Codex `codex-rs/tui/src/app/agents_overview_view.rs` and `bottom_pane/chat_composer.rs`. Crush `internal/ui/dialog/sessions.go`, `inline_editor.go` and `model/sidebar.go` informed scoped dialogs, editable fields, persistent keyboard help and width-dependent layout. This implementation reuses Rind's TUI, line editor, choice selector, composer cursor calculation and theme, without adding another terminal framework.

Orca's `docs/reference/agent-status-store.md` informed the single status projection in the management package: runtime host facts take precedence, waiting for children is distinct from human action, and every surface receives the same summary. Paperclip's `doc/SPEC-implementation.md` informed queue ordering, explicit cancellation and actionable blockers. Task notes and run records provide the activity trail without a second activity database, company model or permissions framework.
