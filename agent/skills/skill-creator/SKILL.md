---
name: skill-creator
description: Create or improve a Skill (a SKILL.md with optional scripts, references and assets). Use when the user asks to make, save, edit or package a reusable workflow as a skill.
---

# Creating a Skill

A Skill is a folder with a `SKILL.md`. Its frontmatter is always visible in the skill catalog; the body is read only when a task needs it, and files beside it only when the body points to them. Keep each layer as small as it can be.

## Where it goes

- This folder only: `.rind/skills/<name>/SKILL.md` under the current working directory.
- Every folder for this user: `~/.rind/skills/<name>/SKILL.md`.

Ask which one when the user has not said. To change an existing Skill, edit the `SKILL.md` at its catalog location.

## Layout

```text
<name>/
├── SKILL.md       required: frontmatter and instructions
├── scripts/       optional: code the instructions tell the agent to run
├── references/    optional: long material read only when needed
└── assets/        optional: templates and files copied into output
```

Reference these files by paths relative to the Skill folder, for example `references/api.md`.

## SKILL.md

```markdown
---
name: <name>
description: <what it does>. Use when <the situations that should trigger it>.
---

# <Title>

<Steps, rules and examples the agent follows.>
```

- `name`: lowercase letters, digits and hyphens, at most 64 characters, the same as the folder name.
- `description`: one or two sentences, at most 1024 characters. It is the only text the model sees before choosing the Skill, so say both what it does and when to use it.
- Optional `disable-model-invocation: true` keeps it out of the catalog; it then runs only when the user types `/skill:<name>`.

## Writing the body

- Write instructions for another capable agent: what to do, in what order, and what to check. Skip general knowledge it already has.
- Prefer one concrete example to a paragraph of explanation.
- Move long reference material, schemas and variants into `references/` and say when to read each file.
- Put repeated or fragile steps into `scripts/` and say how to run them.

## Steps

1. Agree on the name, location and what should trigger the Skill.
2. Write the files with `write_file`.
3. Tell the user it is in the catalog from the next turn, and that `/skill` lists it along with any problem loading it.
