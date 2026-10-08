# Team：注册表关系，而不是目录结构

Team 由独立的 TypeScript 控制面 Agents Management 管理，Python Runtime 不再识别任何 Team 目录约定。任意现有目录都可以注册为 Agent；Team、成员、汇报关系和任务都保存在 `RIND_HOME/agents-management` 下的原子 JSONL 日志与快照中。

~~~mermaid
flowchart TB
    U["用户 / Manager"] --> S["Agents Management 服务"]
    S --> R["注册表<br/>Team · Agent · 成员关系 · 任务"]
    S --> A["Rind 适配器"]
    A -->|"external tools · skill files"| W["Python Worker 会话"]
    W --> D["Agent 的真实工作目录"]
~~~

同一目录可以加入多个 Team；共享工作区的写入型运行按规范化路径串行，Git worktree 注册为独立成员即可并行。Leader 向直接下属分派任务，汇报沿任务树逐级唤醒上级。Worker 只看到适配器为本次运行装配的工具、说明和 Skill 文件（只读的 agent 作用域），不负责组织关系。

成员用哪个模型就是它目录的文件夹默认（见[配置与凭证](../06-models/authentication-and-settings.md)），只存一份，由 Python Runtime 管理；控制面通过 rind/folder_defaults/* 读写，只有用户和 Manager 能改，Manager 的改动作为 notice 进入用户 Inbox。新任务的会话创建时读到最新默认；重试或恢复的任务重新打开旧会话时，适配器先调用 rind/folder_defaults/apply 再运行。任务本身不能携带模型。

旧 `.aiteam` 项目只能通过 `rind agents import <legacy-root>` 只读预览后导入，导入从不修改旧文件。

代码入口：[服务](../../../agent-management/src/service.ts)、[Team](../../../agent-management/src/teams.ts)、[Rind 适配器](../../../agent-management/src/adapters/rind.ts)、[旧项目导入](../../../agent-management/src/legacy.ts)。验证：[服务](../../../agent-management/test/service.test.js)、[适配器](../../../agent-management/test/rind.test.js)。使用说明：[Agents Management](../../agents-management.md)。

[返回系列地图](../README.md)
