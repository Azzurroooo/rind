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

`/agents` opens the interactive overview. At the team level it shows members, workspace paths and statuses; `Tab` switches to tasks. `A` adds a folder, `W` creates a workspace, `G` creates a worktree, `L` chooses a leader, `D` assigns work, `M` opens Manager, and `Enter` opens a member's ordinary Rind conversation. `/manager` starts the Manager in its dedicated workspace.

Non-TTY commands return JSON for mutation commands and support `--json` on list. `rind agents import <legacy-root>` previews old `.aiteam` files; add `--confirm` only after reviewing the fingerprint. Import never edits or removes legacy files.

For delivery details, select a task and press `Enter`. `C` posts a note or answers a blocker addressed to the user, `R` explicitly retries, `S` stops a live managed run, and `U` reconciles an unknown task run after the old process has stopped. Text equivalents are `show`, `note --answer`, `start`, `stop` and `resolve --confirm-stopped`.

On the member list, `X` removes membership while preserving the folder and history; `U` reconciles a direct conversation's unknown run. A leader must be replaced before it can be removed.

When a workspace belongs to multiple teams, a TTY asks which scope to attach. Non-TTY requires `--team <id>` or `--standalone`. Direct conversations are observed as runs, but their private messages are not broadcast. If the local service disconnects, the CLI reconnects and checks the Runtime replay before restoring activity; an unconfirmed run remains reserved until a human confirms it stopped.

An attached Worker keeps one management conversation scope. `/sessions` and `/fork` open the selected history in another managed process, preserving the current conversation when you return; a fork also prefills its selected user message. Open another member through `/agents` or resume with `rind --session <runtime-id> --team <team-id>`. A conversation from another workspace or team cannot reuse the current scope. Unregistered ordinary Rind retains its existing session controls. The first adapter is Rind; external Codex/Claude processes are not automatically observed.

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
