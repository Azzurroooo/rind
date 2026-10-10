# Shell Tools: Control Is Returned, the Process Still Has an Owner

English | [简体中文](shell-tools.zh-CN.md)

For bash, yield_time_ms is "how long to wait before returning control to the model"; timeout_ms is the process's runtime deadline. Reaching the former does not automatically kill the command.

~~~mermaid
flowchart TD
    B["bash(command, cwd, yield_time_ms, timeout_ms, notify)"] --> P["command filter + ShellState"]
    P --> S["ProcessSupervisor"]
    S --> J[("record the start intent first")]
    J --> OS["start a non-interactive process tree"]
    OS --> W{"finished inside the wait window?"}
    W -->|"yes"| RESULT["return a terminal state"]
    W -->|"no"| TASK["return task_id; the same process continues"]
    TASK --> CONTROL["task_control: list / read / wait / cancel"]
~~~

The default wait is 10 seconds, and 0–60 seconds is allowed; timeout_ms may be null, meaning no runtime deadline. ShellState keeps the working directory, environment, and shell choice per session, but every command is a new process: cd or export inside a command does not become persistent Shell state for the next command. A cwd override applies only to the current call.

stdin is DEVNULL, so interactive input is not supported. Windows uses Job Objects to manage process trees, and Unix uses a new process session/process group; cancellation targets the owned process tree. Output is drained while it is written to disk, read cursors are bound to task_id, and multiple readers each advance independently without stealing each other's output.

BashPolicy is a call filter for a small number of dangerous commands, not a script sandbox. Worker shutdown must stop owned tasks; handing a command to the background does not mean an independent daemon may be left behind.

Code entry points: [ShellTools](../../../agent/infrastructure/tools/shell/tool.py), [process supervision](../../../agent/infrastructure/tools/shell/supervisor.py), [process tree](../../../agent/infrastructure/tools/shell/process_tree.py). Verification: [shell arguments and lifecycle](../../../test/test_shell_tasks.py), [process supervision](../../../test/test_process_supervisor.py).

[Back to the series map](../README.md)
