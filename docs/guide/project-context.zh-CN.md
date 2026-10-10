# 把项目装进 Rind

English | [简体中文](project-context.zh-CN.md)

目标：让 Rind 不用每次重复问，就知道这个项目的规矩、惯用法和可复用能力。

## 项目说明：RIND.md

`/init` 起草项目说明：

```text
/init             项目级（提交到仓库，团队共享）
/init user        用户级（~/.rind/，只对你生效）
```

RIND.md 是纯 Markdown，写什么都不会被执行——它是持久注入每轮请求的指令：构建命令、代码风格、目录约定、禁忌事项。项目级和用户级会叠加，项目级在后。

## Skills：按需加载的能力包

Skill 是一个包含 `SKILL.md` 的目录，frontmatter 里要有 `description`（通常还有 `name`）。你自己的 Skill 放在：

| 用于 | 位置 |
| --- | --- |
| 当前目录 | 工作目录下的 `.rind/skills/<skill-name>/SKILL.md` |
| 你的所有目录 | `RIND_HOME/skills/<skill-name>/SKILL.md` |

Rind 也会读取你的 Claude Skill（`~/.claude/skills`、`./.claude/skills`）和 Codex Skill（`~/.codex/skills`、`~/.agents/skills` 及对应的 `./` 项目目录）。让 Rind 帮你写一个 Skill 时，它会按内置的 `skill-creator` 来做。

每次请求只带**目录**：名称、描述和文件位置。任务匹配某个 Skill 时，模型会读取它的 `SKILL.md`。想马上用一个：

```text
$skill-name           在 prompt 里 @ 它
/skill:skill-name     整条消息就是一个 Skill 调用
/skill                列出全部 Skill、各自来源，以及加载失败的文件
/import               选择这个对话读取哪些 Claude 和 Codex Skill
```

`/skill:name` 找不到会直接报错；普通的 `$name` 若不是已存在 Skill，就按普通文本处理。被调用的 Skill 正文会以快照进入会话，之后即使文件被删也不影响这次会话。

同名时，更具体的层级优先：项目级高于用户级；同一级里 Rind 高于 Codex，Codex 高于 Claude。`/import` 的选择属于当前对话；对话中途修改会让下一次请求无法命中提示词缓存，所以 Rind 会先确认。

## 每项目的默认模型/强度

见[让 Rind 用上你指定的模型](models.zh-CN.md#让项目记住默认值)：`rind config set model ... --folder [dir]`，逐目录固化。

## 背后的规则

Skill 的层级、解析规则与目录见 [Skill 的渐进披露](../internals/02-context/skills.zh-CN.md)；RIND.md 如何与其他来源叠加见[指令从哪里来](../internals/02-context/prompt-assembly.zh-CN.md)。

[返回场景索引](README.zh-CN.md)
