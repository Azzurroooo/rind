# Rind 无状态 Session Execution 内核重构计划

## 1. 目标与原则

### 目标

将当前“每个打开过的 session 缓存一套完整 `SessionRuntime`”改为：

```text
Worker 进程长期运行
Session 历史按 session_id 持久化读取
Turn execution 只在运行期间创建
Turn 结束后释放 execution
```

最终结构：

```text
Worker
├── ACP Server
├── SessionRepository
├── CommandRouter
├── Shared Tool/Skill/Provider Services
├── TurnRunner（无 session 持久状态）
└── active_turns: session_id -> AgentRuntime
```

### 约束

- surface 与内核之间只使用现有 ACP/JSONL 接口；不让 CLI/Desktop 直接调用内部运行对象。
- 保留现有 `session_id`、`turn_id`、`request_id`、`input_id` 语义，不新增同义身份字段。
- 不修改 session 历史 JSONL 格式。
- 不为未来远程调度、分布式 worker 池或多租户预留字段。
- 优先改造现有 `SessionStore`、`AgentRuntime`、`TurnRunner` 和 `WorkerStdioRuntimeServer`；只有现有职责无法拆分时才新增实体。
- 不保留两套长期实现。迁移完成后删除完整 `SessionRuntime` 常驻缓存路径。

## 2. 当前问题边界

当前路径：

```text
session/replay 或 session/prompt
  -> RuntimeWorker 按 session_id 路由
  -> 创建或读取完整 session 运行对象
  -> 运行对象进入 active_turns（仅 prompt 路径）
```

这会让仅浏览历史的 session 也创建：

- `AgentRuntime`
- `TurnRunner`
- `ToolRegistry` / `ToolExecutor`
- `SkillRepository`
- `ContextManager`
- session 级 provider wrapper

这些对象在 turn 结束后仍留在 worker 的 session 缓存中，直到 worker 退出。

需要严格区分：

```text
session：持久化逻辑资源，不等于运行对象
turn：一次执行生命周期
sampling：turn 内的一次模型请求
worker：应用级进程和服务所有者
ACP：surface 与 worker 的唯一边界
```

## 3. 目标资源所有权

### Worker 级资源

只保存无 session 可变状态的对象：

- ACP 请求解析、响应和事件 writer；
- slash command registry/router；
- provider 底层连接和模型目录；
- 工具 schema、参数校验和无状态工具定义；
- skill 元数据读取服务；
- stream parser、result normalizer、compaction policy 等无状态服务；
- `active_turns` 调度表。

worker 级服务不能保存当前 session、当前 turn 或可变的 session model。

### 持久化 Session 级状态

由现有 `SessionStore`/`JsonlSessionStore` 改造成按 ID 访问的 repository 能力：

- `session_id`；
- workspace/cwd；
- session model/config override；
- 历史消息和 tool records；
- turn state/checkpoint；
- skill catalog；
- goal、compaction 和 session metadata。

repository 每次通过 `session_id` 定位数据，不为每个 session 长期保存完整 store 实例。

### Active Turn 级状态

只在 session 有运行中 turn 时保留：

- `turn_id`；
- turn lock；
- cancellation token；
- steering/follow-up 队列；
- pending user question；
- 当前 turn 的恢复状态。

优先复用现有 `AgentRuntime` 作为 active turn owner。它直接作为 `active_turns[session_id]` 的临时执行对象，不再嵌套在长期 session 容器中。

释放条件：

```text
turn_completed / turn_failed / turn_cancelled
且没有 pending input、user question 或仍需恢复的执行
  -> 从 active_turns 删除 AgentRuntime
```

历史仍由 repository 保留，下次请求重新按 `session_id` 加载。

## 4. ACP 契约

不新增协议层级，继续使用现有方法。

### 只读请求

```json
{
  "method": "session/replay",
  "params": {
    "session_id": "s-1",
    "start": 0,
    "end": 200
  }
}
```

语义：只读取持久化历史、turn state 和当前 model。不得创建 active turn，不得创建 `AgentRuntime` 或 `TurnRunner`。

### Prompt 请求

```json
{
  "method": "session/prompt",
  "params": {
    "session_id": "s-1",
    "input": "继续实现"
  }
}
```

worker 根据 `active_turns` 判断：

- session 空闲：创建临时 AgentRuntime 并启动 turn；
- session 有 active turn：按当前 steer/queue 规则处理；
- 同一 session 的并发 prompt：返回稳定冲突或进入既定输入策略，不创建第二个 turn。

### 控制请求

以下请求继续显式携带 `session_id`；turn 控制同时携带 `turn_id`：

```text
session/cancel
rind/session/steer
rind/session/follow_up
rind/session/unsteer
rind/session/dequeue_follow_up
rind/user-question/respond
rind/session/compact
```

控制请求只能访问对应的 active execution；没有 active execution 时返回 `TurnNotActive` 或现有等价错误。

### Slash command 请求

当前统一接口是：

```text
rind/command/execute
```

不是 `session/command`。

请求：

```json
{
  "method": "rind/command/execute",
  "params": {
    "session_id": "s-1",
    "input": "/status"
  }
}
```

处理边界：

```text
ACP Server
  -> CommandRouter.execute(raw_input, session_id)
  -> slash syntax/parser
  -> command handler
  -> repository / active_turn service
  -> SlashCommandResult
```

surface 只负责输入和结果渲染，不复制 Runtime slash command 的解析或业务逻辑。纯 UI 操作不作为 Runtime slash command；需要 session 或 worker 状态的命令全部走 ACP。

## 5. 内核组件改造顺序

### Phase 0：固定协议和行为

1. 保持现有 ACP 方法名和响应字段。
2. 增加测试确认 `session/replay` 是只读操作，不产生 turn 事件。
3. 增加测试确认缺失/未知 `session_id` 返回稳定错误。
4. 固定 `queued_input_delivered`、turn 终态和 replay 的现有语义。

验收：协议 golden fixture、CLI、Desktop 现有测试全部通过。

### Phase 1：建立按 ID 的 SessionRepository 边界

1. 以现有 `SessionStore`/`JsonlSessionStore` 为实现基础，增加按 `session_id` 读取和写入的内部路径。
2. 迁移 `session/replay`、`session/list`、status/config/skill 等只读逻辑到 repository 路径。
3. `session/replay` 不再调用 `RuntimeWorker.session()`。
4. 创建 session 只写入 metadata 和历史根记录，不创建完整 AgentContainer。
5. 删除现有 `SessionRuntime` 常驻容器路径，active turn 直接由 `AgentRuntime` 持有所需执行状态。

验收：浏览任意数量历史 session 后，active turn 数保持为零，内存中不出现等量完整 runtime。

### Phase 2：将 AgentRuntime 改为 active execution

1. 由 `RuntimeWorker` 直接维护 active execution 表；禁止 replay/list 写入该表。
2. prompt admission 成功后才创建对应 session 的 AgentRuntime。
3. AgentRuntime 从 repository 按 `session_id` 读取历史、model、workspace 和 skill catalog。
4. turn 终态统一触发 execution release。
5. release 前检查 pending input、user question、恢复状态；不满足条件时保留 execution 并返回可观察状态。
6. 不新增 idle timer；第一版使用“turn 终态立即释放”的确定性规则。

验收：

- turn 结束后 active execution 表移除 session；
- replay 不创建 execution；
- steer/queue/cancel 只影响对应 active turn；
- worker shutdown 能清理所有剩余 execution。

### Phase 3：TurnRunner 无状态化

1. 保留 `TurnRunner` 作为 worker 级执行服务。
2. 将 session store、model、workspace 和 turn 信息改为调用参数或通过 `session_id` 查询。
3. 不让 TurnRunner 保存当前 session、当前 model 或 session-specific queue。
4. provider 请求使用“共享底层 client + 每次请求传 model/reasoning 参数”；不能共享包含可变 model 的 client wrapper。
5. 工具执行继续使用已有 `session_id`、`turn_id` 和 `tool_call_id`，不新增重复 identity 字段。
6. 复用现有 tool idempotency 机制，恢复时按 `tool_call_id` 查询已完成结果，避免重复副作用。

验收：两个 session 并行 sampling 时，model、workspace、history、tool result 和事件完全隔离。

### Phase 4：统一 Worker Server 路由

1. `WorkerStdioRuntimeServer` 直接持有 repository、command router、execution coordinator 和 shared services。
2. 删除按 session 缓存完整 `StdioRuntimeServer` 的生产路径，所有请求由 worker server 按 session_id 直接路由。
3. 所有 session-scoped 请求在 ACP 路由边界统一校验 `session_id`。
4. 所有 turn-scoped 请求在同一边界统一校验 `turn_id`。
5. 所有事件由 worker 根据实际 session/turn 生成元数据，surface 不自行推断。

验收：server 内不存在“当前 session”隐式路由；CLI/Desktop 只通过 ACP 请求和事件工作。

### Phase 5：删除旧常驻路径和做资源验收

1. 删除按 session 长期缓存完整 AgentContainer 的路径。
2. 删除没有生产调用方的 `SessionRuntime` 兼容字段和测试夹具。
3. 检查 provider client、MCP、shell/background、workspace lock 的关闭边界。
4. worker 退出时先终止 active executions，再关闭共享 provider/MCP/工具资源。
5. 保留历史文件，不因 execution release 删除 session 数据。

## 6. 最小接口形状

优先使用现有方法名，不新增平行接口：

```text
SessionRepository
  replay(session_id, start, end)
  metadata(session_id)
  context(session_id)
  append_message(session_id, message)
  append_tool_result(session_id, tool_call_id, result)
  turn_state(session_id)

ExecutionCoordinator
  prompt(session_id, input)
  cancel(session_id, turn_id)
  steer(session_id, turn_id, input)
  follow_up(session_id, input)
  release(session_id, turn_id)

TurnRunner
  run(session_id, turn_id, cancellation, transient_messages)

CommandRouter
  execute(session_id, raw_input)
```

这些名称表示职责边界；实现时优先改造现有类和方法，不为每个接口再创建一层同义 wrapper。

## 7. 测试矩阵

### ACP/Repository

- `session/replay` 不创建 active execution；
- replay 读取正确 session 的历史、model 和 turn state；
- 100 个 session list/replay 后 active execution 数为零；
- 未知 session 返回 `SessionNotFound`；
- `rind/command/execute` 按 session_id 执行，不访问错误 session。

### Execution/Turn

- 空闲 session prompt 创建一个 execution；
- tool call 后继续 sampling；
- turn completed/failed/cancelled 后释放 execution；
- steer/queue/cancel 的 session_id 和 turn_id 不匹配时拒绝；
- 同一 session 不能同时存在两个 active turn；
- 不同 session 可以并行 turn，事件和历史不串线。

### 资源生命周期

- 浏览历史不会创建完整 tool/skill/turn 对象；
- turn 结束后 provider wrapper、queue 和 listener 不残留；
- worker shutdown 取消所有 active execution，并关闭共享资源一次；
- session 再次 prompt 可以从持久化历史恢复；
- 重启 worker 后 session history 和 model/config 仍可读取。

### Surface 回归

- CLI/Desktop 只使用 ACP request/event；
- session 切换不启动第二 worker；
- 多 session 事件按 session_id/turn_id 隔离；
- slash command catalog、参数解析和结果语义一致。

## 8. 性能验收

记录改造前后以下指标，不设置未经测量的固定 SLA：

```text
worker process spawn -> initialize ready
session/replay latency
idle session prompt -> turn_started
turn terminal -> execution release
打开 N 个 session 后的 active execution 数和内存
```

预期：

- worker 启动成本只发生一次；
- replay 延迟接近 repository 读取耗时，不包含 AgentContainer 构造；
- turn 结束后 active execution 数回到零；
- session 数增长不会导致完整 runtime 数量线性增长。

## 9. 迁移和回滚边界

- 每个 phase 保持现有 ACP 方法兼容，先替换内部实现，再删除旧路径。
- 历史 session 文件不迁移、不重写；repository 继续读取现有格式。
- 任何 phase 失败时，可以暂时恢复旧的 active execution 创建路径，但不能同时保留两套对外协议。
- 不引入 session TTL 作为第一版依赖；先完成 turn 终态释放，再根据实测决定是否需要 workspace 级缓存 TTL。

## 10. 完成标准

以下条件全部满足才视为完成：

1. `session/replay`、session list 和只读命令不创建 active turn execution。
2. 只有运行中的 turn 才保留 session 级 AgentRuntime。
3. Turn 终态后 execution 被释放，历史和配置仍可恢复。
4. TurnRunner、工具定义、command router 和 provider transport 不保存隐式当前 session。
5. 所有 surface 与内核业务交互均经 ACP。
6. 多 session 并发时 history、tool、model、queue 和事件严格隔离。
7. 没有重复的 `session_id`、`turn_id`、`worker_id` 或兼容 runtime identity 字段。
8. worker 只在应用生命周期启动一次，退出时统一清理 active execution 和共享资源。
