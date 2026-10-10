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

Skill 是一个目录下的 `SKILL.md`，带 frontmatter（`name`、`description`），放在这些位置：

| 作用域 | 位置 |
| --- | --- |
| 用户 | `RIND_HOME/skills/<skill-name>/SKILL.md` |
| 项目 | `<项目根>/.rind/skills/<skill-name>/SKILL.md` |

每个会话只注入**目录**（名称、描述、作用域），不注入正文。需要时：

```text
$skill-name           在 prompt 里 @ 它
/skill:skill-name     整条消息就是一个 Skill 调用
/skill list           列出当前可见的 Skill
```

`/skill:name` 找不到会直接报错；普通的 `$name` 若不是已存在 Skill，就按普通文本处理。被调用的 Skill 正文会以快照进入会话，之后即使文件被删也不影响这次会话。模型也可以用 `skill` 工具主动读取指定 Skill。

同名时作用域更具体的覆盖用户级（项目 > 用户）。

## 每项目的默认模型/强度

见[让 Rind 用上你指定的模型](models.zh-CN.md#让项目记住默认值)：`rind config set model ... --folder [dir]`，逐目录固化。

## 背后的规则

Skill 的发现与边界（符号链接、路径逃逸）见 [Skill 的渐进披露](../internals/02-context/skills.zh-CN.md)；RIND.md 如何与其他来源叠加见[指令从哪里来](../internals/02-context/prompt-assembly.zh-CN.md)。

[返回场景索引](README.zh-CN.md)
