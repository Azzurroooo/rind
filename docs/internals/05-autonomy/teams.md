# Team: registry relationships, not directory structure

English | [简体中文](teams.zh-CN.md)

Teams are managed by Agents Management, an independent TypeScript control plane; the Python Runtime no longer recognizes any Team directory conventions. Any existing directory can be registered as an Agent. Teams, members, reporting relationships, and tasks are all stored in atomic JSONL logs and snapshots under `RIND_HOME/agents-management`.

~~~mermaid
flowchart TB
    U["User / Manager"] --> S["Agents Management service"]
    S --> R["Registry<br/>Team · Agent · member relationships · tasks"]
    S --> A["Rind adapter"]
    A -->|"external tools · skill files"| W["Python Worker session"]
    W --> D["The Agent's real working directory"]
~~~

The same directory can join multiple Teams. Runs that write to a shared workspace are serialized by normalized path, while registering a Git worktree as an independent member allows them to run in parallel. A Worker sees only the tools, instructions, and Skill files that the adapter assembled for this run — a read-only agent scope — and has no responsibility for organizational relationships.

Members have only two team tools, decided by the same table that governs what is declared and what the service accepts ([tools.ts](../../../agent-management/src/tools.ts)): members with direct reports and the Leader have delegate (assign work, open a worktree or an empty directory for a new subordinate, send work back, cancel, retire a subordinate they added), and a task run has report (deliver or report a blocker). A task run does not have ask_user_question. All other actions, including model selection, belong solely to the user and the Manager. The delegator is woken once, after all the work it dispatched has settled: the parent task re-runs with the results (the brief is not resent), and the conversation is delivered by the Runtime's rind/session/deliver as the next turn; when the Runtime does not host that conversation, the service saves it and delivers it afterward, once it is hosted. Delivered files are copied under artifacts/<team>/<recipient>/<task>/, the path is given in the results, and the recipient reads them with read_file; this is guidance, not a sandbox.

Which model a member uses is the folder default of its directory (see [configuration and credentials](../06-models/authentication-and-settings.md)). It is stored in exactly one place and managed by the Python Runtime; the control plane reads and writes it through rind/folder_defaults/*, and only the user and the Manager can change it, with the Manager's changes entering the user Inbox as a notice. A new task's session reads the latest defaults when it is created; when a retried or resumed task reopens an old session, the adapter calls rind/folder_defaults/apply first and then runs. A task itself cannot carry a model.

Legacy `.aiteam` projects can only be imported after a read-only preview with `rind agents import <legacy-root>`; importing never modifies the original files.

Code entry points: [service](../../../agent-management/src/service.ts), [Team](../../../agent-management/src/teams.ts), [Rind adapter](../../../agent-management/src/adapters/rind.ts), [legacy project import](../../../agent-management/src/legacy.ts). Verification: [service](../../../agent-management/test/service.test.js), [delivery](../../../agent-management/test/delivery.test.js), [new subordinates and retirement](../../../agent-management/test/team-growth.test.js), [adapter](../../../agent-management/test/rind.test.js). Usage: [Agents Management](../../agents-management.md).

[Back to the series map](../README.md)
