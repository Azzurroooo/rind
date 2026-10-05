# 信任边界：每一层只保证自己检查过的事情

Rind 能访问宿主机文件与进程。协议认证、文件路径约束、外部内容标记分别解决不同问题；它们没有合成为一个操作系统沙箱。

~~~mermaid
flowchart TD
    U["远程用户"] --> A["连接认证<br/>server token / 一次性 ticket"]
    A --> W["Worker 协议方法"]
    W --> F["文件工具<br/>路径解析 / Capsule allowed roots"]
    W --> S["Shell<br/>宿主机进程权限"]
    X["网页与进程输出"] --> N["工具结果 / 不可信内容标记"]
    N --> M["模型上下文"]
    M --> W
~~~

## 三条需要分清的界线

| 边界 | 实际检查 | 不应推导出的保证 |
| --- | --- | --- |
| 远程连接 | Python Web server 无 token 时只允许回环绑定；配置 token 后校验认证，支持一次性 ticket | 连上服务后每条 shell 命令还会独立申请操作系统权限 |
| 文件与 Capsule | 解析路径、校验适用的 allowed roots；Team 文件工具限制在自己的 Capsule 与 shared 等允许区域 | Shell、外部编辑器和其他 Worker 也受同一目录隔离 |
| 内容进入模型 | 任务通知把可信任务事实与 untrusted_process_output 分开，工具结果保持来源 | 文本标记能从机制上阻止所有提示注入 |

Python Web server 支持 Bearer、token/ticket 等认证路径，Origin 检查约束浏览器来源；Desktop Gateway 自己维护访问码、票据和来源规则。两套入口共享运行时协议，却不应被描述成同一套认证实现。[消息渠道 Gateway](../07-surfaces/gateway.md) 另有 allowlist、pairing 和群提及门控。

文件改写队列只协调当前 Worker 的受管写入；预映像检查能发现部分并发修改，但检查和替换之间不是原子 compare-and-swap。Shell 的 BashPolicy 是有限禁止规则，不是容器或沙箱。授权远程使用 Worker，实质上也在授权其已暴露的宿主机工具能力。

## 秘密和诊断也有归属

供应商凭证存于本机 auth.json，界面拿到的是公开设置和认证状态；原始 LLM trace 会保留普通提示与模型文本，仅对图片数据做特殊省略。诊断材料不能一概视为已经脱敏。

源码：[Python Web 认证](../../../agent/runtime/server/websocket.py)、[Desktop Gateway](../../../desktop/src/main/gateway/server.ts)、[凭证](../../../agent/infrastructure/credentials.py)、[任务通知](../../../agent/application/task_notifications.py)。验证：[Web 运行时](../../../test/test_web_runtime.py)、[网关安全](../../../test/test_gateway_security.py)。细节：[文件工具](../04-tools/file-tools.md)、[Team](../05-autonomy/teams.md)、[观测](observability.md)。

[返回系列地图](../README.md)
