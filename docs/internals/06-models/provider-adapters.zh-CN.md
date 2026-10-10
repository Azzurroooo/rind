# 模型适配：把供应商协议收束为两种调用

English | [简体中文](provider-adapters.md)

执行内核只依赖 ChatClient：create 返回完整 ModelCompletion，stream 产生 ModelStreamEvent，close 释放连接。普通回合走流式调用；压缩摘要可以使用带请求级输出上限的完整调用。供应商的消息格式、工具参数和终止原因在适配层转换。

~~~mermaid
flowchart LR
    R["TurnRunner / 压缩服务"] --> I["ChatClient<br/>create · stream · close"]
    P["ProviderService<br/>凭证 + 端点 + 模型选择"] --> I
    I --> C["OpenAI Chat"]
    I --> O["OpenAI Responses"]
    I --> A["Anthropic Messages"]
    I --> G["Google Generative AI"]
    C & O & A & G --> E["ModelCompletion / ModelStreamEvent"]
    E --> R
~~~

## 一次调用经过什么

1. ProviderService 解析凭证、端点、模型与 reasoning effort，按供应商定义的 api 创建客户端。
2. 适配器把内部消息和工具声明转成远端格式；图片在这里转换为供应商需要的数据，远端不接收本机文件路径。
3. 流式增量统一交给内核解析；工具参数可以分块到达，不能把每个片段当成一次完整调用。
4. 完成原因、用量和错误回到统一模型类型；容器释放时关闭客户端。

统一接口不代表所有供应商功能相同。图像能力、上下文窗口和支持的 effort 来自[模型目录](model-catalog.zh-CN.md)；LongCat 会清空通用 reasoning_effort，避免发送不支持的字段。当前创建客户端的分支看 definition.api；通用设置中的 api 还用于目录元数据及刷新判断，不能据此推断任意 api 值都能切换适配器。

## 取消与重试各有边界

公共取消辅助器同时等待下一项和取消信号，取消与数据同时就绪时优先取消；退出后清理活跃读取任务和订阅。这样上层无需为每种 SDK 重写取消竞争逻辑。

重试策略仍有供应商差异：Chat 客户端的 OpenAI SDK 配置 max_retries=14，Responses 使用默认构造参数 2；模型目录刷新另设 0 次 SDK 重试和 10 秒总时限。这些不能合并成“内核统一重试 N 次”。协议兼容也不保证模型会正确调用工具，行为验证仍需区分本地模拟与真实供应商。

源码：[端口](../../../agent/application/ports/chat_client.py)、[客户端装配](../../../agent/infrastructure/llm/provider_service.py)、[Chat](../../../agent/infrastructure/llm/openai_chat.py)、[Responses](../../../agent/infrastructure/llm/openai_responses.py)、[Anthropic](../../../agent/infrastructure/llm/anthropic_messages.py)、[Google](../../../agent/infrastructure/llm/google_generative_ai.py)、[取消辅助器](../../../agent/infrastructure/llm/cancellation.py)。验证：[供应商生命周期](../../../test/test_provider_lifecycle.py)、[模拟供应商集成](../../../test/test_provider_e2e.py)。

[返回系列地图](../README.zh-CN.md)
