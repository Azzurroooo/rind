# Bash JSONL 低负载修复验收记录

日期：2026-09-28。分支：`feature/bash-task-upgrade`。任务事实继续保存在每个 session 的 `tasks.jsonl`，未新增生产依赖。

## 回归

- Python 全量 `python -m pytest test -q`：首次 1351 passed、2 skipped、2 failed，修正了仍只提供旧 `records()` 接口的测试替身。再次全量为 1351 passed、2 skipped、2 failed，失败分别为 app-server 初始化超过测试的 15 秒限额，以及 CLI 进程未在 25 秒内连接测试端口。这两项首次组合复测仍超时；之后单独复测均通过，再次组合复测为 2 passed（10.85 秒）。未调整产品或测试超时，保留全量非全绿的事实。
- 受影响 Python 集成回归：129 passed，覆盖 JSONL 增量索引、跨 Worker 追加、文件替换、损坏末尾、索引溢出、写入失败、任务投递与 Runtime 续接。
- CLI 全量：482 passed、1 skipped（清除测试 shell 继承的 `NO_COLOR` 后执行）。
- `git diff --check`：通过。

## 历史增长基准

`python test/bench_task_journal.py` 是 L1 组件基准，模拟当前 session 的 0、1000、10000 条已完成任务，分别重复 100 次空闲相关读取、turn 定向读取及更新、后台输出尾预览、Runtime 监看列表。三种历史规模下，四场景的历史回退扫描次数均为 0；任务索引最多 256 项，session 索引为 1 项；进程私有内存约 24.1–25.1 MiB。10000 条历史时，每 100 次的 CPU 时间分别约为 219、703、250、250 ms。首次吸收 JSONL、显式历史分页和跨进程终端开销不在这些数字内。

`node frontend-cli/test/bench-tui.mjs` 的 L1 虚拟绘制样本中，400 与 4000 条历史的 30 帧输出均为 921–960 字节。它不测量真实终端 UI，也不构成公共负载评分。

## 真实终端

状态：`NOT RUN`。此前已授权使用本地 fake provider 进行真实可见终端验收，但桌面画面捕获返回 `FrameArrived timed out`，未取得可核验画面。因此本次不以虚拟终端或组件基准代替真实终端结论，也不声明端到端 CPU、内存达到最优。
