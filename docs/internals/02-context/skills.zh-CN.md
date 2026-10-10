# Skill：目录先出现，模型需要时自己读文件

English | [简体中文](skills.md)

Rind 不在每次模型请求里放入全部 SKILL.md。目录告诉模型有哪些 Skill、每个文件在哪里；任务匹配时，模型用 `read_file` 读取文件。用户显式调用时，正文直接进入会话。没有专门的 Skill 工具。

~~~mermaid
flowchart LR
    LAYERS["八个层级，按优先级排列"] --> SCAN["用 PyYAML 解析 frontmatter"]
    IMPORTS["会话 skill_sources"] --> SCAN
    SCAN --> INDEX["会话目录：名称 · 描述 · 位置"]
    INDEX --> CM["ContextManager 注入 available_skills"]
    CM --> READ["模型：read_file 读取位置"]
    CALL["$name / /skill:name"] --> SNAP[("会话 skill_snapshot")]
    SNAP --> CM
~~~

## 层级

SkillRepository 读取八个层级；同名（不分大小写）时，后面的层级覆盖前面的：

| 层级 | 目录 | 开关 |
| --- | --- | --- |
| Rind · 内置 | 安装目录中的 `agent/skills` | 始终开启 |
| Claude · 用户 | `~/.claude/skills` | `/import` |
| Codex · 用户 | `~/.codex/skills`，然后 `~/.agents/skills` | `/import` |
| Rind · 用户 | `RIND_HOME/skills` | 始终开启 |
| Claude · 项目 | `<cwd>/.claude/skills` | `/import` |
| Codex · 项目 | `<cwd>/.codex/skills`，然后 `<cwd>/.agents/skills` | `/import` |
| Rind · 项目 | `<cwd>/.rind/skills` | 始终开启 |
| 团队 | 分配给该成员的 SKILL.md 文件 | 始终开启 |

每个目录贡献其直接子目录中的 `<name>/SKILL.md`。以 `.` 开头的目录会被跳过，Codex 自带的 `~/.codex/skills/.system` 因此不会读入。符号链接的 Skill 目录会被跟随，Skill 的位置记为真实路径。项目级层级以工作目录为根，和 `RIND.md` 一致，不会上溯到 Git 根。

## 解析与问题

frontmatter 是 YAML，用 `yaml.safe_load` 读取；值里出现未加引号的 `key: a: b` 冒号时，会加上引号重新解析。只读取三个顶层字段：

- `name`：缺省时取目录名，只能包含字母、数字、连字符和下划线。与目录名不一致时只给警告。
- `description`：必填。空白（包括 `|`、`>` 多行块里的换行）合并成一行。目录里最多显示 1024 个字符。
- `disable-model-invocation: true`：不进入目录，但仍可以用 `/skill:name` 调用。

其他字段（`metadata`、`allowed-tools` 等）一律忽略，也不会覆盖顶层字段。解析失败或缺少描述的文件会被跳过。每个问题和警告都连同位置一起保留，由 `/skill` 列出。

## 目录与会话状态

每轮开始时，SkillTurnCoordinator 重新扫描各层级，把生效且允许模型调用的 Skill 写入会话的 `skill_catalog`；compact 之后的那一轮同样会重新扫描。只有条目变化时才写入，因此目录这条 system 消息在提示词缓存中保持稳定。新对话从第一条消息起就有目录，某轮中新写入的 Skill 从下一轮出现。工具里没有 `read_file` 的会话不注入目录，Manager 就是这种情况。

会话元数据里的 `skill_sources` 记录这个对话读取哪些 Claude 和 Codex 层级。在 `/import` 改动之前它不存在，表示全部开启。fork 会继承它；窗口在第一条消息之前做出的选择，会随第一条消息一起保存。`/import` 修改正在运行的对话时会立即同步目录，因此下一次模型请求就会使用新目录，那次请求无法命中提示词缓存。

## 显式调用

用户输入落盘时，SkillTurnCoordinator 按会话当前读取的层级解析 `/skill:name` 和 `$name`。`/skill:name` 找不到会报错；`$name` 若不是已有 Skill，就按普通文本处理。成功调用的正文连同位置以 `skill_snapshot` 存入会话，之后恢复不依赖磁盘上的文件保持不变。

## 发现不等于权限

Skill 正文是说明，不是执行器，也不会授予任何工具。SKILL.md 描述的事情，仍然只能通过容器已有的工具完成，而 `read_file` 没有目录边界。克隆来的仓库里项目级的 `.claude`、`.agents` 目录会像 `RIND.md` 一样进入目录；`/skill` 会标明每个 Skill 的来源，`/import` 可以关掉这些层级。如何编写 Skill，见内置的 `skill-creator`。

代码入口：[SkillRepository](../../../agent/infrastructure/skills.py)、[解析与目录](../../../agent/domain/skills.py)、[目录与调用](../../../agent/application/skill_selection.py)、[/skill](../../../agent/runtime/server/commands/skill.py)、[/import](../../../agent/runtime/server/commands/import_skills.py)。验证：[Skill 仓库](../../../test/test_skill_repository.py)、[目录与会话](../../../test/test_skill_catalog_session.py)、[命令](../../../test/test_skill_commands.py)。

[返回系列地图](../README.zh-CN.md)
