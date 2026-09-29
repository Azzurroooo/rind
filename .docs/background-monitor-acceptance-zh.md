# Background 监看验收记录

日期：2026-09-28
分支：`feature/bash-task-upgrade`
范围：本地 fake provider、无付费模型

## 自动与虚拟终端

- `frontend-cli/test/task-monitor-layout.test.js`：通过。覆盖 100/10,000 条历史任务、Background/Delegates、宽度 4–160、高度 0–50、Unicode、输出窗口、过期提示、NO_COLOR 和每帧格式化上限。
- `frontend-cli/test/tui-integration.test.js`：通过。覆盖 80×24、100×30、160×50、32×6、resize、长 Unicode 输入、光标、PageUp/PageDown/End、Ctrl+B 关闭和关闭后停止预览读取。
- `frontend-cli/test/task-monitor-controller.test.js`：通过 19 项。覆盖 Runtime handoff 确认、前台定向释放、完成保留、分页失败、选择稳定、迟到响应、跨 session 隔离和自动 yield。
- CLI 全量：480 passed、1 skipped、0 failed（共 481 项）。监看、布局、键盘和虚拟终端专项：51 passed；专项包含在全量中，不重复计数。
- 受影响 Python 回归：`test/test_shell_tasks.py test/test_task_delivery.py test/test_task_journal.py test/test_task_continuation.py test/test_task_cli_journey.py test/test_bash_session_isolation.py test/test_bash_background_wait.py test/test_runtime_server_protocol.py test/test_runtime_server_subscriptions.py`，107 passed。
- 补充恢复、list、read 的 handoff 保持断言后，单独重跑 `test/test_task_journal.py`：8 passed。

### 执行命令与首次失败处理

CLI 全量在 `frontend-cli` 目录执行：

```powershell
Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue
node --test --test-reporter=spec "test/*.test.js"
```

首次执行有 3 项既有 `context-board.test.js` 颜色断言失败，原因是测试进程继承了 `NO_COLOR`。仅清除本次测试 shell 的该环境变量后，全量通过；未修改产品配色或这些断言。监看布局对 NO_COLOR 的独立覆盖保持通过。

Python 回归在仓库根目录执行：

```powershell
python -m pytest test/test_shell_tasks.py test/test_task_delivery.py test/test_task_journal.py test/test_task_continuation.py test/test_task_cli_journey.py test/test_bash_session_isolation.py test/test_bash_background_wait.py test/test_runtime_server_protocol.py test/test_runtime_server_subscriptions.py -q
python -m pytest test/test_task_journal.py -q
```

首次扩大范围的 Python 回归为 106 passed、1 failed：app-server 冷启动 initialize 实测约 5.245 秒，超过测试原有 5 秒响应限额。仅将此测试的初始化等待调整为 15 秒，后续请求仍保持 5 秒；完整重跑后 107 passed。该调整不改变产品超时或运行逻辑。

## 真实终端

状态：`NOT RUN`（画面证据不可用）。

已尝试通过 Windows 原生窗口截图读取当前 VS Code 窗口；窗口恢复后仍返回 `FrameArrived timed out: timed out waiting on channel`。因无法获得画面，未启动真实终端验收会话，也不以虚拟终端通过替代真实桌面验收。未调用付费模型。

冷启动诊断只向本地 app-server 发送 initialize/shutdown，进程退出码为 0；临时会话目录自动清理。本轮测试进程均已结束，CLI 全量临时日志已清理。

## 结论

本组确定性 CLI 与虚拟终端验收通过；真实可见终端画面仍需在截图能力可用时按同一 fake provider 场景复测。
