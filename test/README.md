# 测试分类

| 类型 | 位置 | 何时执行 | 模型 |
| --- | --- | --- | --- |
| 自动回归 | `test/test_*.py`、`frontend-cli/test/*.test.js`，以及各前端已有测试 | 修改代码后按影响范围自动执行；可进入 CI | mock 或本地 fake provider，不消耗真实模型 token |
| 用户流程验收 | [`manual/`](manual/README.md) | 用户明确要求后，按指定场景执行 | 按用例使用真实模型，或不调用模型 |

自动回归包括单元、模块集成和可重复的进程级测试。`test_journeys_user.py`、`test_context_journeys.py`、`frontend-cli/test/auth-journey.test.js` 等现有脚本使用本地模拟模型，仍属于自动回归。它们验证流程契约，但不能证明真实模型会遵循 RIND.md、保留压缩后的任务信息或完成目标。

保留现有自动测试路径，避免为分类搬动导入和测试入口。第二类使用独立目录和人工验收文档，不新增自动执行器；Markdown 不会被 pytest 或 Node 测试命令收集。

## 自动回归入口

在仓库根目录执行，可按改动范围选择单个文件：

```sh
python -m pytest test/ -q
npm --prefix frontend-cli test
```

新增自动测试必须隔离临时工作区、会话目录和模型依赖，不能因本机存在 API key 就改用真实服务。需要真实 provider、真实账号或人工观察的测试，放入 `manual/`，不要加入默认测试入口。

## 用户流程验收入口

例如用户说“测试 S01–S08”或“用已配置模型验收 RIND.md 和 auto compact”，才按照 [manual/README.md](manual/README.md) 选取用例执行。普通的“实现功能”“修复问题”“跑回归”不触发这一类。

每个用例必须写明：前置状态、操作步骤、通过标准、证据和 token 消耗类型。验收结果按 `PASS / FAIL / BLOCKED / NOT RUN` 记录；未达到触发条件不能算通过。模拟验证与真实模型验收分别报告，不能互相替代。
