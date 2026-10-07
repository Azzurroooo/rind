# Team：用目录保存专家职责与工作积累

Team 的长期状态是目录、身份清单和成果文件。一个专家可以多次执行任务；复用的是职责和文件，每次 execute 委派仍产生新的子会话。

~~~mermaid
flowchart TB
    P["项目根目录"] --> MAN[".aiteam/project.yaml<br/>项目与 main_agent"]
    P --> AG["agents/"]
    P --> SH["shared/<br/>共享输入与交付物"]
    AG --> MAIN["main-agent/"]
    AG --> SPEC["specialist/"]
    SPEC --> ID[".aiteam/agent.yaml"]
    SPEC --> PROMPT[".aiteam/prompts/"]
    SPEC --> FILES["memory / work / outputs"]
    MAIN -->|"delegate"| SPEC
    SPEC -->|"发布文件"| SH
~~~

initialize_team_project 建立项目与主 Agent；initialize_team_agent 创建标准 Capsule，Blueprint 可以从用户目录复制专家配置。目录本身就是注册结果，不另建常驻组织服务。discover_agent 从当前工作区找清单，让同一执行内核获得 workspace_root、project_id、owner_agent_id 与系统提示。

主 Agent 获得专家目录以及 delegate、agent_create 工具。文件工具解析 shared/ 为项目共享目录，限制 Team Agent 访问自己的工作区和 shared；其会话输出与图片有明确读取例外。这个限制是文件工具边界，**不是 OS 沙箱**，不能推广为 Shell 也受同样目录隔离。

直接进入 Agent 工作区执行可用 WorkspaceLock 防止并发占用；Worker 内的委派特意关闭这把工作区锁以支持并发。多个委派可能共享同一专家目录，需要协调输出路径；逐文件修改队列只防止同 Worker 文件工具写入交错。

代码入口：[Team 项目](../../../agent/infrastructure/team/project.py)、[清单](../../../agent/infrastructure/team/manifests.py)、[装配](../../../agent/bootstrap/container.py)。验证：[Team 项目](../../../test/test_team_project.py)、[委派](../../../test/test_team_delegation.py)。

[返回系列地图](../README.md)
