# 把工作派给一个团队

English | [简体中文](teams.zh-CN.md)

目标：多个项目/角色并行推进时，让 Rind 团队替你盯着，而不是你一个人切窗口。

## 打开管理页

输入框为空时按 **←**，进入 Agents Management。Manager 也在这一页，可以用自然语言让它帮你组队、派活。

终端另一条路是 `rind agents` 命令：

```bash
rind agents team create product
rind agents team add product /work/project --position Builder
rind agents team add product /work/reviewer --position Reviewer
rind agents task product reviewer "Review the current change and report evidence."
```

## 心智模型

- **每个成员就是一个普通文件夹**：文件夹的 basename 是初始名字，`--position` 只是展示标签。
- **Team 是注册关系**：同一目录可以加入多个团队；跨团队复用目录时会建议先建副本，`--share` 是显式共享。
- **共享目录串行写， worktree 可并行**：`rind agents team worktree product <name> <repo> <branch>` 为并行开发开一份独立成员。
- **首个成员只是首任 leader**，不会因此多出任何文件权限。

## 派活与回收

指派任务时说清交付物与证据；成员完成后回执会唤醒派给它的人。任务只有**有效回执 + 确认执行结束**才算 `done`；中途失联的运行标为 Unconfirmed，不会自动重跑。

阻塞必须指名回应者（`user` 或某个成员）和所需动作，否则派活的人等不到东西。

想旁观或插手具体某个成员的会话：在管理页进入它的对话，和普通 Rind 会话没有区别。

## 更细的规则

成员增减、层级调整、旧 Team 导入、异常恢复见 [Agents Management 使用说明](../agents-management.zh-CN.md)。

[返回场景索引](README.zh-CN.md)
