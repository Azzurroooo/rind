# 会话存储：小文件各管一件事

SessionStore 不把对话、工具和元数据揉进一份大对象。JSONL 负责可追加事实，meta.json 负责可更新的会话状态与摘要。

~~~mermaid
flowchart TB
    ROOT["~/.rind/sessions/session_id/"] --> META["meta.json<br/>模型 · 目标 · 终态"]
    ROOT --> MSG["messages.jsonl<br/>消息事实"]
    ROOT --> TOOL["tool_calls.jsonl<br/>工具调用与结果"]
    ROOT --> COMP["compactions.jsonl<br/>压缩记录，按需出现"]
    ROOT --> TASK["tasks.jsonl<br/>受管进程事实，按需出现"]
    ROOT --> ATT["attachments/ 与 tool-output/"]
    INDEX["~/.rind/session_index.json"] --> ROOT
~~~

JsonlSessionStore 把职责交给 MessageRepository、ToolCallRepository、CompactionRepository 和 SessionIndexRepository。默认数据根在 RIND_HOME/sessions；显式 session_dir 使用自己的 index.json。首次创建会话时先有 meta、messages、tool_calls，其他文件按功能出现。会话和工作区绑定，恢复时校验 schema 与身份。

SessionFiles 用文件锁串行化读写；JSONL 追加后 flush/fsync，meta 等 JSON 先写同目录临时文件再替换。索引用于快速列出会话，不应当作完整历史的唯一来源。这个布局让读取历史、查看元数据和后台进程日志各走适合自己的路径。

## 单文件可靠性与跨文件一致性分开处理

JSON 临时替换避免读到半份 meta，JSONL 追加使旧消息无需重写；文件锁和 fsync 各自解决竞争与提交问题。但一次业务操作可能写多个文件，不能把这些局部机制合并描述为数据库事务。

例如压缩先有记录、再有边界消息；投影必须同时找到有效匹配，孤立的一半不应改变模型上下文。工具调用记录与消息也按 call ID 重新关联，缺失结果以明确占位呈现。普通历史读取的宽容规则与 TaskJournal 的严格日志修复规则不同，不能假设所有 JSONL 都以同一种方式跳过损坏行。

plan.json 也是按需存在的会话控制文件。原始对话、当前计划和进程日志分别读写，让重放历史不必加载所有大输出，也让计划变化无需重写对话。

代码入口：[JsonlSessionStore](../../../agent/infrastructure/persistence/jsonl_session_store.py)、[SessionFiles](../../../agent/infrastructure/persistence/session_files.py)。验证：[异步会话存储](../../../test/test_async_session_store.py)、[会话分叉](../../../test/test_persistence_session_fork.py)。

[返回系列地图](../README.md)
