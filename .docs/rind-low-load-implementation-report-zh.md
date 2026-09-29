# Rind 低负载优化实施记录

日期：2026-09-28。分支：`feature/bash-task-upgrade`。实施前基线：`541ee4d`，其中应用源码与方案引用的 `e7c02e6` 一致。

本记录区分已实现、自动回归、局部性能证据和未完成验收。**目前不能宣布 P0–P7 全部完成，不能宣布四产品公共评分领先，也没有测得实际功耗。**

## 已实现的改动

| 阶段 | 交付 | 边界 |
|---|---|---|
| P0 部分 | 可重复组件/TUI/取消基准、版本与 fixture/output hash、本地 SSE 交互回放入口 | 尚缺整机进程树采样、全 C01–C10 fixture 和 L3 校准 |
| P1 | 完成工具接收结果时只解析一次；最新宽度行缓存；显式失效；ASCII 字宽与分段快路径 | 未引入全局缓存；原始结果仍可展开；首帧仍可能拆分完整输出 |
| P2 | controller 单一按需时钟；移除工具私有 timer；统一帧时间；非 TTY 无动画 timer | 保留 Working；Waiting 4.2 秒呼吸，150 ms 采样，NO_COLOR 按秒刷新；真实终端观感待验收 |
| P3a | transcript 显式内容失效；TUI 复用稳定根分段与归一化行，跳过稳定前缀 diff；缓存不变 Markdown pending | 状态帧不遍历历史；内容追加仍可能重建 transcript，不能称作完整 P3b |
| P4 部分 | terminal `write(false)`/`drain`；输入即时帧；33 ms 普通帧；单一 Runtime 文本合并边界；256 项/1 MiB 流队列；大文本/参数分片 | 未改 stdio 阻塞 writer、前端事件 Promise 链；不能声称全链路全部有界 |
| P5 有证据部分 | 每流一次取消订阅，取消当前 read task；所有 provider 显式关闭迭代作用域 | 未改未剖析的序列化、projection/deepcopy、trace 或存储结构 |
| P7 工具部分 | Windows 评分计算及完整交互 UI/场景覆盖/体验门槛校验 | 候选预算尚未完成 P0 校准；不存在正式分数或排名 |

所有变更沿用既有事件协议和模块依赖方向；没有添加生产依赖、修改版本号或发布产物。已删除被替代的工具 timer、TUI 全帧平铺/reset、每 chunk 取消等待逻辑和重复取消检查。缓存数组只读；未知可变数组仍走兼容渲染。

## 局部性能证据

以下全部为 **L1，禁止用于公共计分或换算整机 CPU/瓦数**。原始样本位于本目录的 `low-load-*.json`。

| 相同 fixture | 改前中位数 | 改后中位数 | 解释 |
|---|---:|---:|---|
| 400 个完成工具，连续 render | 234.628 ms/帧 | 0.096 ms/帧 | 单独完成工具缓存阶段；全部语义输出 hash 相同 |
| 400 个完成工具，TUI 状态帧 | 0.542 ms/帧 | 0.0093 ms/帧 | 改前已包含 P1；无真实终端绘制 |
| 4,000 个完成工具，TUI 状态帧 | 7.558 ms/帧 | 0.0063 ms/帧 | 不再按历史行数重复计算；此量级的小数差异不作排名解释 |
| Python 10,000 个 chunk，取消感知迭代 | 1,031.25 CPU ms | 156.25 CPU ms | 5 次独立计时；cProfile 另跑，不计入计时样本 |

Python profile 的函数调用数由约 265 万降到 82 万；每个 chunk 的 cancellation waiter、wait/gather 调度被移除。这个实验不能解释任意实际 turn 的全部 Python CPU。

渲染样本的 manifest SHA 是测量时 HEAD，某些测量发生在对应实现提交之前；实际改动版本分别由下表的实施提交确定。不要把“测量时 HEAD”误当作全部工作树源码都已包含在该提交中。

| 样本 | 对应实现 |
|---|---|
| `low-load-baseline-l1.json` | `541ee4d` 应用源码 |
| `low-load-tool-cache-l1.json` | `cc5a9b0` 工具缓存 |
| `low-load-ascii-l1.json` | `204bf6b` ASCII 快路径 |
| `low-load-before-layout-l1.json` | `16b01cc` 调度阶段 |
| `low-load-after-layout-l1.json` | `74e500c` 稳定状态帧 |
| `low-load-cancellation-before.json` | 从 `7d5cc87` 读取旧取消实现，在独立 Python 进程内运行 |
| `low-load-cancellation-after.json` | `07b6c4c` 取消优化 |

## 回归

覆盖工具完成/失败/取消、迟到参数、展开、宽度与主题失效；ASCII/CJK/ZWJ/组合音标/ANSI/控制字符；状态帧不重算完成历史；屏幕、scrollback、光标与 tour 重入；慢终端保留全部历史追加；正文合并顺序、大参数、多 session 隔离；满队列取消、停滞网络、SDK 异常、关闭异常和取消订阅回收。

首次 CLI 全量测试继承了 `NO_COLOR=1`，使三项要求彩色输出的既有测试失败；移除该环境变量后通过。Python 首次全量中的失败来自旧 stream mock 缺少异步 close 和旧测试假定逐 token 即时分发；已修正 mock 契约，并改为验证完整内容、边界顺序和有限时间内提前可见，不删除验收条件。

Python 全量回归：1,332 passed、2 skipped（227.64 秒）；全量收集后补充的 stream close 异常用例包含在单独的 7 项 stream-pump 回归中，全部通过。CLI 全量回归：462 passed、1 skipped；其后增加的工具时钟回归包含在单独的 3 项 activity-clock 回归中，全部通过。

### 真实终端验收准备（2026-09-28）

用户已明确授权使用本地 fake provider 执行真实可见终端验收，无需再次申请。独立 Windows 控制台、Rind CLI 和 Python Runtime 已成功启动，但 Computer Use 对目标控制台两次画面捕获均超时，对 Codex 窗口也出现 `window capture timed out`。无法确认实际画面、前台绘制和交互正确性，本次记为 **BLOCKED**，不计作 L3 通过，不产生公共评分。已向用户请求确认桌面可见状态；阻碍来自画面捕获环境，不是授权不足。

试跑拥有的 provider PID 32312、CLI PID 9952、Runtime PID 28048、console host PID 10976 均已退出，临时 `rind-bench-w8__p4ld` 目录已不存在，没有修改用户配置或调用付费模型。

新增开发期 Windows 进程采样入口 `test/bench_processes.py`：250 ms 单调时钟样本，按显式 root/tree 分组记录 Private Bytes、working set、累计 CPU 和采样器自身开销。保留已观察到且后来重新挂靠的子进程；以 PID + 创建时间区分进程；重复归属报错；读失败和退出不静默忽略。**轮询不能覆盖两次采样间出生并退出的进程，也缺少最终退出 CPU，所以仍是诊断工具，不能充当方案要求的完整进程生命周期计分仪器。**

采样/评分/启动器工具共 20 项回归通过，包含正常退出、中断以及已有报告文件保护时的进程/临时目录清理；另以真实 Windows 进程运行 1 秒采样，获得 5 个样本，Private Bytes 字段完整、无读取错误，诊断对象与采样器单独列账。此运行不是终端性能成绩。交互回放新增启动身份 manifest、provider 日志隔离以及已观察子进程的退出清理；psutil 仅加入开发依赖，未加入 Runtime 依赖。

## 尚未完成，不能隐去

1. P0/P7：固定构建的四产品完整交互 L3、进程树 Private Bytes/CPU、终端 CPU、可见输入/流式延迟、置信区间与完整 C01–C10 比较。现有回放只是 smoke fixture，没有假装为完整公共基准。
2. P3b：内容持续追加时的稳定块/活动尾部布局；超长无换行正文、动态表格等仍需独立 profile 与正确性 oracle，当前只保证不变 pending 可复用。
3. P4：stdio 同步写入阻塞与 CLI 异步事件链的完整背压。直接暂停整个 stdout 管道会同时挡住应答，必须验证控制请求依赖和关闭竞态，不能用一个 `pause()` 宣布完成。
4. P6：持久化历史的按 ID 读取/恢复、展示缓存总预算、长期追加保留策略及 60 分钟压力验收。当前完整历史对象仍常驻；没有通过删除历史或破坏 ctrl+o 来伪造内存下降。
5. X01–X10 真实终端/长跑场景未执行；已有自动虚拟终端、假 provider 回归不替代这些验收。

后续在桌面画面捕获恢复后继续已授权的真实终端验收，补齐 P0 仪器及公共 fixture，再依证据选择 P3b/P4/P6 最小改动。Windows 当前 PATH 中有 Codex/Cargo，未发现 Pi、Crush 和 Go 命令；竞品源码已固定，但不能拿未经核对的已安装 Codex 版本代替方案指定构建。

开发入口与评分输入单位见 `test/performance.md`。每个阶段独立 Git 提交，不依赖生产切换开关回滚。
