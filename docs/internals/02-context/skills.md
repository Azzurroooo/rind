# Skill: the catalog appears first, the model reads the file when it needs it

English | [简体中文](skills.zh-CN.md)

Rind does not put every SKILL.md into every model request. The catalog tells the model which skills exist and where each file is; the model reads a file with `read_file` when a task matches it. A user's explicit invocation puts the body into the conversation directly. There is no skill-specific tool.

~~~mermaid
flowchart LR
    LAYERS["Eight layers, in precedence order"] --> SCAN["Parse frontmatter with PyYAML"]
    IMPORTS["Session skill_sources"] --> SCAN
    SCAN --> INDEX["Session catalog: name · description · location"]
    INDEX --> CM["ContextManager injects available_skills"]
    CM --> READ["Model: read_file location"]
    CALL["$name / /skill:name"] --> SNAP[("Session skill_snapshot")]
    SNAP --> CM
~~~

## Layers

SkillRepository reads eight layers. A later layer overrides an earlier one by name, case-insensitively:

| Layer | Folders | Switch |
| --- | --- | --- |
| Rind · built-in | `RIND_HOME/skills/.system` | always on |
| Claude · user | `~/.claude/skills` | `/import` |
| Codex · user | `~/.codex/skills`, then `~/.agents/skills` | `/import` |
| Rind · user | `RIND_HOME/skills` | always on |
| Claude · project | `<cwd>/.claude/skills` | `/import` |
| Codex · project | `<cwd>/.codex/skills`, then `<cwd>/.agents/skills` | `/import` |
| Rind · project | `<cwd>/.rind/skills` | always on |
| Team | SKILL.md files assigned to the member | always on |

Each folder contributes its direct `<name>/SKILL.md` children. Folders starting with `.` are skipped, so the Rind user layer never lists `.system` again, and Codex's own `~/.codex/skills/.system` is left out. Symlinked skill folders are followed, and a skill's location is its real path. The project layers are rooted at the working directory, as `RIND.md` is, not at a parent Git root.

## Built-in skills

Built-in skills ship in the install as `agent/skills` and are read from `RIND_HOME/skills/.system`, so every way of installing Rind (installer, npm, portable, source) uses the same code and needs no install step. When a Worker starts, `install_system_skills` compares a SHA-256 of the bundled files with the `.bundle` marker in `.system`. A match costs one small read. A mismatch, after an update or on first start, copies the bundle beside `.system` under a file lock and swaps it in by renaming, so a reader sees the old copy or the new one, never a mix. Leftovers of an interrupted copy are removed. A failure is logged and does not stop the Worker; when `.system` holds no skill, `/skill` reports that built-in skills are missing.

`.system` belongs to Rind and is replaced on update. A skill with the same name in `RIND_HOME/skills` overrides a built-in one.

## Parsing and problems

The frontmatter is YAML and is read with `yaml.safe_load`. A value with an unquoted `key: a: b` colon is quoted and parsed again. Only three top-level fields count:

- `name` defaults to the folder name and must use letters, digits, hyphens and underscores. A name that differs from its folder only warns.
- `description` is required. Whitespace, including the lines of a `|` or `>` block, is joined into one line. The catalog shows at most 1024 characters.
- `disable-model-invocation: true` keeps the skill out of the catalog; `/skill:name` still uses it.

Other fields (`metadata`, `allowed-tools`, …) are ignored and never replace the top-level ones. A file that fails to parse or lacks a description is skipped. Every problem and warning is kept with its location, and `/skill` lists them.

## Catalog and session state

At the start of every turn, SkillTurnCoordinator rescans the layers and writes the effective, model-invocable skills to the session's `skill_catalog`. A turn after compaction is rescanned too. The write happens only when the entries changed, so the catalog's system message stays stable for the prompt cache. A new conversation gets its catalog from its first message, and a skill written during a turn appears from the next one. A session whose tools do not include `read_file` gets no catalog; the Manager is one.

`skill_sources` in the session metadata records which Claude and Codex layers the conversation reads. It is absent, meaning all on, until `/import` changes it. A fork inherits it, and a window's choice before the first message is saved with that message. When `/import` changes it for a hosted conversation, the catalog is synced at once, so the next model request already uses it, and that request cannot reuse the prompt cache.

## Explicit invocation

SkillTurnCoordinator parses `/skill:name` and `$name` when user input is persisted, against the layers the session currently reads. An unknown `/skill:name` raises an error. A `$name` that names no skill is left as text. A successful invocation stores its body as a `skill_snapshot` with its location, so later recovery does not depend on the file staying unchanged.

## Discovery is not permission

A skill body is instructions, not an executor, and it grants no tools. What a SKILL.md describes can still only be done through the tools the container already has, and `read_file` has no directory boundary. Project-level `.claude` and `.agents` folders in a cloned repository enter the catalog like `RIND.md` does; `/skill` shows where each skill comes from, and `/import` switches those layers off. The built-in `skill-creator` skill explains how to write one.

Code entry points: [SkillRepository](../../../agent/infrastructure/skills.py), [parsing and catalog](../../../agent/domain/skills.py), [catalog and invocation](../../../agent/application/skill_selection.py), [/skill](../../../agent/runtime/server/commands/skill.py), [/import](../../../agent/runtime/server/commands/import_skills.py). Verification: [Skill repository](../../../test/test_skill_repository.py), [catalog and session](../../../test/test_skill_catalog_session.py), [commands](../../../test/test_skill_commands.py).

[Back to the series map](../README.md)
