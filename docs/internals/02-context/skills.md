# Skill：目录先出现，正文按需进入

Rind 不在每次模型请求里放入全部 SKILL.md。先让模型知道“有哪些能力”，用户显式调用或工具读取时才加载具体内容。

~~~mermaid
flowchart LR
    U["用户级 skills"] --> SCAN["只扫描 frontmatter"]
    P["项目级 skills"] --> SCAN
    A["Agent 级 skills"] --> SCAN
    SCAN --> INDEX["会话 Skill 目录"]
    INDEX --> CM["ContextManager 注入简短索引"]
    CALL["$name / /skill:name"] --> LOAD["加载有效 SKILL.md"]
    LOAD --> SNAP[("会话 skill_snapshot")]
    SNAP --> CM
~~~

SkillRepository 按用户、项目、Agent 作用域扫描；同名时后面的更具体作用域覆盖前者。扫描只读 frontmatter，正文在 load_skill 时检查路径仍位于作用域内，再解析全文。目录同步失败会保留上一份目录，不使当前回合因扫描错误而丢失既有 Skill 信息。

显式调用由 SkillTurnCoordinator 在用户输入落盘时解析：/skill:name 未找到会报错，普通 $name 若不是已存在 Skill 不作为调用。成功调用的正文以 skill_snapshot 存入会话，后续恢复不依赖磁盘 Skill 文件恰好仍保持原样。模型也可经 skill 工具主动读取指定内容。

## 文件发现与执行权限是两回事

默认用户目录为 RIND_HOME/skills，项目目录为项目根/.rind/skills；Agent 作用域由装配时传入。仓库扫描各目录的直接子目录，读取其中的 SKILL.md，按名称忽略大小写合并。发现和加载均检查作用域边界，符号链接目录或 SKILL.md 不作为越界读取捷径。

Skill 的正文是按需加载的说明，不是新的 Python 执行器，也不会自动给 Agent 增添未注册工具。把一个能力写进 SKILL.md 后，它仍只能通过当前容器已经拥有的工具实现。目录索引解决可发现性，会话快照解决此次激活的可追溯性，两者承担不同职责。

代码入口：[SkillRepository](../../../agent/infrastructure/skills.py)、[激活协调](../../../agent/application/skill_selection.py)、[Skill 工具](../../../agent/infrastructure/tools/skill.py)。验证：[Skill 仓库](../../../test/test_skill_repository.py)、[激活事件](../../../test/test_skill_activation_event.py)。

[返回系列地图](../README.md)
