# Delegate the work to a Team

English | [简体中文](teams.zh-CN.md)

Goal: when multiple projects / roles need to advance in parallel, let the Rind Team watch them for you instead of switching windows all by yourself.

## Open the management page

With the input box empty, press **←** to enter Agents Management (or run `rind agents` in a terminal). Create a team with `n`, add members with `a`, and assign a task to a member with `t`. The Manager is on this page too, and you can use natural language to have it help you put a team together and hand out work.

Teams and tasks are created only here or by the Manager, never by a command or an agent's shell, so every task has someone waiting for its receipt.

## Mental model

- **Every member is an ordinary folder**: the folder's basename is its initial name, and its role is only a display label.
- **A Team is a registration relationship**: the same directory can join multiple teams; when reusing a directory across teams you will be advised to make a copy first, and sharing is an explicit choice.
- **Shared directories write serially; worktrees can run in parallel**: **Add member › New Git worktree** opens a separate member for parallel development.
- **The first member is only the initial leader**, and it gains no extra file permissions for that.

## Handing out work and getting it back

State the deliverable and the evidence when assigning a task; once a member finishes, a receipt wakes the person who assigned it. A task only counts as `done` with **a valid receipt + a confirmed end of execution**; a run that lost contact midway is marked Unconfirmed and is not automatically re-run.

A blocker must name the responder (`user` or a member) and the required action, otherwise the person who assigned the work gets nothing back.

To watch or step into a specific member's session: enter its conversation from the management page, and it is no different from an ordinary Rind session.

## Finer-grained rules

For adding and removing members, hierarchy adjustments, importing old Teams and recovery from failures, see the [Agents Management documentation](../agents-management.md).

[Back to the scenario index](README.md)
