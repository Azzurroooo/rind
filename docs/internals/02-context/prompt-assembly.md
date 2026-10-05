# 模型指令从哪里来

系统提示不是一个不断追加的字符串。Rind 把稳定身份、工作区规则、运行时能力与会话历史分开，在每次请求前按来源组装。

~~~mermaid
flowchart TB
    BASE["基础系统提示 + 环境"] --> CM["ContextManager"]
    DOC["用户 / 项目 RIND.md"] --> CM
    GOAL["Goal 策略"] --> CM
    TEAM["Agent 身份 / Team 目录"] --> CM
    SKILL["Skill 元数据目录"] --> CM
    HIST[("会话消息投影")] --> CM
    CM --> REQ["模型消息列表"]
~~~

装配根用 build_system_prompt 创建基础提示；Team Agent 的 system.md 会加入身份；启用 Goal 时再注入 Goal 策略。ContextManager 读取用户级和项目级 RIND.md，分别最多注入 32 KiB，并记录截断或读取错误；Skill 目录只注入元数据索引，不把所有 Skill 正文塞进每轮请求。

运行时消息插在首条 system 消息之后；最近会话消息按原顺序保留。Goal 检查点属于一次续接的临时输入，用户给出的目标被标记为数据而非更高优先级指令。每类注入都能在 context stats/decisions 中看到，避免“模型为什么知道这个”只能靠猜。

代码入口：[系统提示](../../../agent/prompts.py)、[RIND.md 加载](../../../agent/infrastructure/rind_docs.py)、[上下文组装](../../../agent/application/context/manager.py)。验证：[提示回归](../../../test/test_prompts.py)、[RIND.md 回归](../../../test/test_rind_docs.py)。

[返回系列地图](../README.md)
