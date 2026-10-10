# 验证设计：每种证据只证明它覆盖的那一层

English | [简体中文](verification.md)

系列各篇的测试链接是实现的可追溯入口，不表示本次文档编写运行过全部测试。确定性回归验证协议与机制，真实模型验收验证用户目标和模型行为，两类结果必须分开报告。

~~~mermaid
flowchart TD
    U["单元测试<br/>边界 / 纯函数 / 状态转换"] --> I["模块集成<br/>存储 / 取消 / 工具配对"]
    I --> P["本地 fake provider 进程测试<br/>真实协议与进程，模拟模型"]
    P --> S["Surface 测试<br/>虚拟终端 / DOM / Electron 桥接"]
    S -.-> A["独立手动验收<br/>真实模型 / 真实设备 / 明确场景"]
    G["协议 golden fixture"] --> P
    G --> S
~~~

## 机制要落到能失败的断言

| 设计主张 | 合适的证据 |
| --- | --- |
| 多 Surface 理解同一种事件 | Python 协议测试与 Node golden fixture 读取同一份消息样本 |
| 取消能解除满队列等待 | fake stream 填满队列再取消，验证任务退出与资源关闭 |
| 持久工具结果不重复执行 | 构造未闭合调用与已有结果，恢复后检查执行计数和消息配对 |
| CLI 刷新保住输入与光标 | 虚拟终端测试最终屏幕、光标位置、宽度和输入缓冲 |
| 真模型能从摘要继续复杂任务 | 明确触发压缩并检查成果的用户场景；模拟摘要不能替代 |

## 确定性回归入口

从仓库根目录执行，先安装对应开发依赖；按修改范围选文件即可：

~~~sh
python -m pip install -r requirements.txt
python -m pytest test/ -q
npm --prefix frontend-cli ci
npm --prefix frontend-cli test
npm --prefix frontend-web test
npm --prefix desktop run typecheck
npm --prefix desktop test
npm --prefix mobile test
~~~

Python 和 CLI 测试在 test/、frontend-cli/test/；Web/Mobile 使用 Vitest，Desktop 的 scripts 测试以 Node 运行。fake provider 即使启动了真实子进程，也仍属于确定性回归；不能因为机器上有 API key 就转接真实服务。

## 手动验收与文档维护

只有用户明确要求具体场景或手动验收时，才执行 test/manual 下的计划；记录 PASS / FAIL / BLOCKED / NOT RUN，保留触发条件和证据，结束后清理自己的进程与临时数据。不要把设备连接、真实供应商调用加入默认 CI 或启动检查。

文档本身的检查包括：52 篇主题是否齐全，源码/测试/互链是否存在，Mermaid 是否可解析和渲染，数值与默认值是否有源码依据。后续代码改动应更新相应机制篇，而非另建一份描述同一流程的旧式总览。

依据：[测试分类](../../../test/README.md)、[手动验收目录](../../../test/manual/README.md)、[协议样本](../../../test/fixtures/runtime_protocol.golden.jsonl)、[Python 协议测试](../../../test/test_runtime_server_protocol.py)、[CLI 协议测试](../../../frontend-cli/test/runtime-protocol.test.js)、[虚拟终端集成](../../../frontend-cli/test/tui-integration.test.js)。

[返回系列地图](../README.zh-CN.md)
