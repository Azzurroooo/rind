# Skill: the catalog appears first, the body enters on demand

English | [简体中文](skills.zh-CN.md)

Rind does not put every SKILL.md into every model request. It first tells the model "what capabilities exist", and loads specific content only when the user explicitly invokes it or a tool reads it.

~~~mermaid
flowchart LR
    U["User-level skills"] --> SCAN["Scan frontmatter only"]
    P["Project-level skills"] --> SCAN
    A["Agent-level skills"] --> SCAN
    SCAN --> INDEX["Session Skill catalog"]
    INDEX --> CM["ContextManager injects a short index"]
    CALL["$name / /skill:name"] --> LOAD["Load the effective SKILL.md"]
    LOAD --> SNAP[("Session skill_snapshot")]
    SNAP --> CM
~~~

SkillRepository scans the user, project, and Agent scopes; when names collide, the later, more specific scope overrides the earlier one. Scanning reads only frontmatter, while the body is parsed in full at load_skill, after checking that the path still lies inside its scope. A catalog sync failure keeps the previous catalog, so a scan error does not strip existing Skill information from the current turn.

Explicit invocation is parsed by SkillTurnCoordinator when user input is persisted to disk: an unknown /skill:name raises an error, while an ordinary $name is not treated as an invocation if no Skill of that name exists. The body of a successful invocation is stored in the session as a skill_snapshot, so later recovery does not depend on the on-disk Skill file happening to remain unchanged. The model can also read specified content on its own initiative through the skill tool.

## File discovery and execution permission are two different things

The default user directory is RIND_HOME/skills and the project directory is <project root>/.rind/skills; the Agent scope is passed in at assembly time. The repository scans the direct subdirectories of each directory, reads the SKILL.md inside, and merges them by name, ignoring case. Both discovery and loading check the scope boundary; symlinked directories or SKILL.md files are not a shortcut for out-of-scope reads.

A Skill's body is instructions loaded on demand, not a new Python executor, and it does not automatically give the Agent unregistered tools. Once a capability is written into a SKILL.md, it can still only be implemented through the tools the current container already has. The catalog index solves discoverability, the session snapshot makes this activation traceable, and the two carry different responsibilities.

Code entry points: [SkillRepository](../../../agent/infrastructure/skills.py), [activation coordination](../../../agent/application/skill_selection.py), [Skill tool](../../../agent/infrastructure/tools/skill.py). Verification: [Skill repository](../../../test/test_skill_repository.py), [activation events](../../../test/test_skill_activation_event.py).

[Back to the series map](../README.md)
