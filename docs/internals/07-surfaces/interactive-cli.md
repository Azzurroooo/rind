# 交互式 CLI：把终端当作一个 Surface

CLI 只处理输入、显示和连接生命周期。Worker 仍负责会话、回合、工具和持久化；CLI 收到事件后更新单一组件树，再由 TUI 统一绘制。

~~~mermaid
sequenceDiagram
    participant T as 终端
    participant C as Node CLI/TUI
    participant W as Worker stdio
    T->>C: 键盘、粘贴、命令
    C->>W: request(method, params)
    W-->>C: response + event stream
    C->>C: reducer / transcript / viewport
    C-->>T: 帧 diff（同步输出）
~~~

交互输入经过 command controller；普通文本交给 turn controller，steering 与 follow-up 由独立队列动作处理。外部 `send` 通过 CLI 自己的 IPC listener 注入同一路 dispatch，因此远程输入仍经过同一套命令和队列语义。

TUI 的 render(width) 生成逻辑行，根组件负责 diff；默认最小绘制间隔 33ms。输出写入返回 false 时等待 drain，避免高速模型流挤爆 stdout。绘制使用 DEC 2026 synchronized update、光标标记与 viewport，输入缓冲和光标在刷新中保持。

非 TTY 不启动光标控制和菜单，`rind run` 将最终回答写 stdout，进度与诊断写 stderr。这样管道可以消费干净答案，交互显示仍可展示工具和任务状态。

## Tour：真实渲染器，模拟执行

`rind tour` 和会话内 `/tour` 演示 CLI 布局，但不启动 Worker，不调用模型。pages 保存步骤数据，player 管播放，stage 管模拟状态，render 生成画面，run-tour 才持有 TUI。虚构事件通过现有 transcript/output controller，因此示例和真实会话能复用工具块、流式 Markdown 与菜单排版。

Agents Management 教学用可序列化的虚构快照，复用真实管理页的行投影、任务表单和交付报告渲染器，不连接管理服务。`agents.tasks` 演示受管理父任务结束回合后等待子任务交付、再于同一会话启动新 run；`agents.sessions` 区分普通直接聊天：派发仅创建接收成员的任务，不补建父任务，也不承诺交付后自动续聊。

Agents 章节全部通过交互操作教学，不展示管理子命令：空输入框按 Left 进入，`n` 打开新建团队表单，`a` 打开成员类型菜单，再填写文件夹、角色/职责或 worktree 的仓库、分支、目录与基点；已有归属时展示复制/共享选择。成员的会话列表和聊天入口也由界面展示，模拟表单不访问磁盘、不调用管理动作。

可用 `/tour agents.create`、`/tour agents.tasks`、`/tour agents.sessions` 查看管理教学；`/tour login.account` 演示 OpenAI 账号授权，`/tour login.endpoint` 演示命名端点，`/tour config.folder` 演示文件夹默认。导览中的表单、凭证、任务与测试结果均为模拟，不打开授权页、不写配置、不创建文件。

管理页本身最小宽度是 40 列，导览边框另占 4 列；观看其完整画面时使用至少 44 列的终端。更窄时仍可阅读教学说明，并显示管理页的尺寸提示。

会话内进入导览时暂停主 TUI；退出后 replayAll 恢复原会话显示。播放时钟可注入，测试无需真实等待动画。它验证的是界面教学和渲染，不是模型完成某项工作的能力。

## 从源码运行

需要 Python 3.12+、Node.js 18+。先在仓库根目录创建虚拟环境：

~~~sh
python -m venv .venv
~~~

Windows PowerShell 用 `.\.venv\Scripts\Activate.ps1`，macOS/Linux 用 `source .venv/bin/activate` 激活，再安装并运行：

~~~sh
python -m pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
~~~

从其他工作区启动时使用 CLI 脚本的绝对路径；示例中的 rind 可替换成 `node /absolute/path/to/rind/frontend-cli/bin/rind.js`。登录和端点设置见[配置与凭证](../06-models/authentication-and-settings.md)。只想看操作方式，可运行 `node frontend-cli/bin/rind.js tour agents.create`，需要交互终端。

源码：[CLI 实现](../../../frontend-cli/lib/frontend-cli-implementation.js)、[输入动作](../../../frontend-cli/lib/cli-input-actions.js)、[TUI](../../../frontend-cli/lib/tui/tui.js)、[运行时客户端](../../../frontend-cli/lib/runtime-client.js)、[Tour](../../../frontend-cli/lib/tour/run-tour.js)。验证：[TUI 引擎](../../../frontend-cli/test/tui-engine.test.js)、[虚拟终端集成](../../../frontend-cli/test/tui-integration.test.js)、[输入缓冲](../../../frontend-cli/test/tui-input-buffer.test.js)、[Tour](../../../frontend-cli/test/tour-tui.test.js)。

[返回系列地图](../README.md)
