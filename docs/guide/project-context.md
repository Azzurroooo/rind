# Get the project into Rind

English | [简体中文](project-context.zh-CN.md)

Goal: let Rind know this project's rules, idioms and reusable capabilities without asking you to repeat them every time.

## Project documentation: RIND.md

`/init` drafts the project documentation:

```text
/init             project level (committed to the repo, shared with the team)
/init user        user level (~/.rind/, applies only to you)
```

RIND.md is plain Markdown, and nothing written in it is executed — it is instructions injected into every turn's request: build commands, code style, directory conventions, taboos. The project level and the user level stack, with the project level last.

## Skills: capability packages loaded on demand

A Skill is a `SKILL.md` inside a directory, with frontmatter (`name`, `description`), placed in one of these locations:

| Scope | Location |
| --- | --- |
| User | `RIND_HOME/skills/<skill-name>/SKILL.md` |
| Project | `<project root>/.rind/skills/<skill-name>/SKILL.md` |

Each session injects only the **catalog** (name, description, scope), not the body. When you need one:

```text
$skill-name          @ it in a prompt
/skill:skill-name    the whole message is a single Skill invocation
/skill list          list the Skills currently visible
```

An unknown `/skill:name` reports an error directly; an ordinary `$name` that is not an existing Skill is treated as ordinary text. The body of an invoked Skill enters the session as a snapshot, so deleting the file afterwards does not affect that session. The model can also read a specified Skill proactively with the `skill` tool.

When names collide, the more specific scope overrides the user level (project > user).

## Per-project default model / effort

See [let Rind use the model you specify](models.md#let-the-project-remember-defaults): `rind config set model ... --folder [dir]`, fixed per directory.

## The rules behind it

For Skill discovery and boundaries (symbolic links, path escapes), see [progressive disclosure of Skills](../internals/02-context/skills.md); for how RIND.md stacks with other sources, see [where instructions come from](../internals/02-context/prompt-assembly.md).

[Back to the scenario index](README.md)
