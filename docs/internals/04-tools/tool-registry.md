# ToolSpec：把工具实现和公开契约绑在一起

模型看到的是 schema，执行器调用的是函数。ToolSpec 把两者绑定到同一个定义，避免“文档说能传，函数却不接受”的两套接口。

~~~mermaid
flowchart LR
    F["handler + 参数说明"] --> S["ToolSpec<br/>schema / is_async / normalize_arguments"]
    S --> C["build_builtin_tool_specs"]
    C --> R["DefaultToolRegistry"]
    R --> M["advertised schema → 模型"]
    R --> V["归一化 → 参数校验 → handler"]
~~~

ToolSpec 从函数签名生成参数结构，记录是否异步，以及允许传入的参数。注册表拒绝同名工具；advertised=false 的工具仍可被历史调用恢复，但不会作为新能力公布。bash_output 就通过这条窄兼容边界继续支持旧会话。

参数先过 normalize_arguments，再检查 required 和 unknown。公共参数错误返回 InvalidArguments，并列出 missing、unknown、allowed；运行时注入的 _session_id、_cancellation_token 等不成为模型 schema。这个顺序让旧 file_path 等别名能在校验前转换，又不让未知字段悄悄穿过。

工具是否存在取决于装配：Goal 工具只在启用时注册，受管运行由适配器限定可用工具，one-shot 可以关闭用户问答。添加一个工具的正常路径是定义 ToolSpec、在 catalog 中显式装配、覆盖参数和结果契约测试；无需在 TurnRunner 添加同名分支。

## 扩展点同时承担约束

公开 schema 决定模型能请求什么，handler 签名决定执行器能传什么，advertised 决定新回合能看到什么。历史兼容可以只保留执行能力，不继续鼓励模型选择旧工具；运行时私有参数则由系统注入，不允许模型任意覆盖。

因此新增工具不仅是写一个函数，还要回答三件事：参数如何归一化，成功与失败如何构成结构化结果，在哪种容器配置下暴露。结果大或带图片时再走统一归一化与附件路径，避免一个工具绕开整个系统的输出预算。

代码入口：[ToolSpec](../../../agent/infrastructure/tools/spec.py)、[catalog](../../../agent/infrastructure/tools/catalog.py)、[registry](../../../agent/infrastructure/tools/registry.py)。验证：[注册表测试](../../../test/test_tool_registry.py)。

[返回系列地图](../README.md)
