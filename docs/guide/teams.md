# Delegate the work to a Team

English | [简体中文](teams.zh-CN.md)

Goal: when multiple projects / roles need to advance in parallel, let the Rind Team watch them for you instead of switching windows all by yourself.

## Open the management page

With the input box empty, press **←** to enter Agents Management. The Manager is on this page too, and you can use natural language to have it help you put a team together and hand out work.

The other route is the `rind agents` command in a terminal:

```bash
rind agents team create product
rind agents team add product /work/project --position Builder
rind agents team add product /work/reviewer --position Reviewer
rind agents task product reviewer "Review the current change and report evidence."
```

## Mental model

- **Every member is an ordinary folder**: the folder's basename is its initial name, and `--position` is only a display label.
- **A Team is a registration relationship**: the same directory can join multiple teams; when reusing a directory across teams you will be advised to make a copy first, and `--share` is the explicit shared option.
- **Shared directories write serially; worktrees can run in parallel**: `rind agents team worktree product <name> <repo> <branch>` opens a separate member for parallel development.
- **The first member is only the initial leader**, and it gains no extra file permissions for that.

## Handing out work and getting it back

State the deliverable and the evidence when assigning a task; once a member finishes, a receipt wakes the person who assigned it. A task only counts as `done` with **a valid receipt + a confirmed end of execution**; a run that lost contact midway is marked Unconfirmed and is not automatically re-run.

A blocker must name the responder (`user` or a member) and the required action, otherwise the person who assigned the work gets nothing back.

To watch or step into a specific member's session: enter its conversation from the management page, and it is no different from an ordinary Rind session.

## Finer-grained rules

For adding and removing members, hierarchy adjustments, importing old Teams and recovery from failures, see the [Agents Management documentation](../agents-management.md).

[Back to the scenario index](README.md)
