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

A Skill is a folder with a `SKILL.md` whose frontmatter has a `description` (and usually a `name`). Put your own here:

| For | Location |
| --- | --- |
| This folder | `.rind/skills/<skill-name>/SKILL.md` under the working directory |
| You, everywhere | `~/.rind/skills/<skill-name>/SKILL.md` |

Rind also reads the folder's Claude skills (`./.claude/skills`) and Codex skills (`./.codex/skills`, `./.agents/skills`). Your own Claude and Codex skills (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`) are off until you turn them on with `/import`. Ask Rind to make a skill and it follows the built-in `skill-creator` skill. Built-in skills live in `~/.rind/skills/.system`, which Rind replaces on update; to change one, put a skill with the same name in `~/.rind/skills`.

Each request carries only the **catalog**: name, description and file location. When a task matches a skill, the model reads its `SKILL.md`. To use one now:

```text
$skill-name          @ it in a prompt
/skill:skill-name    the whole message is a single Skill invocation
/skill               every skill, where it comes from, and any file that failed to load
/import              choose which Claude and Codex skills this conversation reads
```

An unknown `/skill:name` reports an error directly; an ordinary `$name` that is not an existing Skill is treated as ordinary text. The body of an invoked Skill enters the session as a snapshot, so deleting the file afterwards does not affect that session.

When names collide, the more specific layer wins: project over user, and Rind over Codex over Claude at the same level. `/import` choices belong to the conversation; changing them mid-conversation costs the next request its prompt cache, so Rind asks first.

## Per-project default model / effort

See [let Rind use the model you specify](models.md#let-the-project-remember-defaults): `rind config set model ... --folder [dir]`, fixed per directory.

## The rules behind it

For the skill layers, parsing rules and the catalog, see [progressive disclosure of Skills](../internals/02-context/skills.md); for how RIND.md stacks with other sources, see [where instructions come from](../internals/02-context/prompt-assembly.md).

[Back to the scenario index](README.md)
