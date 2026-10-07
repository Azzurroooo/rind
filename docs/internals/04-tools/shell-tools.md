# Shell 工具：返回控制权，进程仍有主人

bash 的 yield_time_ms 是“等多久再把控制权还给模型”，timeout_ms 才是进程的运行期限。到达前者不会自动杀掉命令。

~~~mermaid
flowchart TD
    B["bash(command, cwd, yield_time_ms, timeout_ms, notify)"] --> P["命令过滤 + ShellState"]
    P --> S["ProcessSupervisor"]
    S --> J[("先记启动意图")]
    J --> OS["启动非交互进程树"]
    OS --> W{"等待窗口内结束？"}
    W -->|"是"| RESULT["返回终态"]
    W -->|"否"| TASK["返回 task_id；同一进程继续"]
    TASK --> CONTROL["task_control：list / read / wait / cancel"]
~~~

默认等待 10 秒，允许 0–60 秒；timeout_ms 可为空，表示无运行期限。ShellState 按会话保留工作目录、环境与 shell 选择，但每次命令都是新进程：命令里的 cd 或 export 不会成为下一次命令的持久 Shell 状态。cwd 覆盖只作用于本次调用。

stdin 为 DEVNULL，因此不支持交互式输入。Windows 用 Job Object 管进程树，Unix 用新的进程会话/进程组；取消针对拥有的进程树。输出一边排空一边落盘，读游标绑定 task_id，多读者各自推进，不抢走彼此输出。

BashPolicy 是少量危险命令的调用过滤，不是脚本沙箱。Worker 关闭要停止 owned tasks；交给后台也不意味着可以留下独立守护进程。

代码入口：[ShellTools](../../../agent/infrastructure/tools/shell/tool.py)、[进程监督](../../../agent/infrastructure/tools/shell/supervisor.py)、[进程树](../../../agent/infrastructure/tools/shell/process_tree.py)。验证：[Shell 参数与生命周期](../../../test/test_shell_tasks.py)、[进程监督](../../../test/test_process_supervisor.py)。

[返回系列地图](../README.md)
