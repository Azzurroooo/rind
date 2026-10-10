# 模型目录：选择模型，也解析能力

English | [简体中文](model-catalog.md)

目录既服务于 /model 菜单，也给内核提供 image_input 和 context_window。模型名称相似不足以证明能力相同；端点和精确模型 ID 才是匹配依据。

~~~mermaid
flowchart TD
    S["当前 provider + endpoint + model ID"] --> C{"同端点缓存含有效能力？"}
    C -->|"是"| V["采用缓存字段"]
    C -->|"缺失字段"| B{"官方端点与内建 ID 精确匹配？"}
    B -->|"是"| F["补充内建能力"]
    B -->|"否"| U["保留 unknown"]
    V & F & U --> R["模型能力<br/>图像过滤 / 上下文预算"]
    T["显式刷新 / 首次初始化后台刷新"] --> N["远端 models.list"]
    N -->|"成功且非空"| W["替换对应目录缓存"]
    N -->|"失败或无效"| K["保留已有缓存"]
~~~

## 读取和刷新分开

普通 list_models 不发 HTTP 请求；显式 refresh 才主动拉取，初始化还会安排一次过期缓存刷新。24 小时 TTL 是刷新条件，**不是读取截止时间**：只要端点匹配，过期缓存仍能提供目录。刷新失败返回提示并继续显示已存模型。

成功刷新以新列表为准，远端删除的模型不继续混入列表。旧能力字段只在同端点、同 ID 下补用；空列表、异常和无效 ID 不覆盖旧缓存。即使当前选中的模型不在枚举列表中，目录仍补入该选择，便于展示自定义模型。

## 三态能力比猜测更可靠

| 字段 | 已知值的作用 | 未知时 |
| --- | --- | --- |
| image_input | false 时省略图片；true 时允许适配器提交 | 保留尝试路径，不按名称认定支持 |
| context_window | 为会话上下文预算提供窗口 | 使用内核默认窗口 |
| reasoning_efforts | 约束菜单和适配器可用级别 | 不凭模型名字补造级别 |

远端字段按供应商已实现的格式读取：例如 OpenRouter 的 architecture.input_modalities/context_length、Mistral 的 capabilities.vision/max_context_length、Groq 的 context_window。内建回退要求官方端点匹配；通用兼容端点也可匹配已知官方目录，DeepSeek 根端点另有 /v1 归一化。换成代理端点后，不应自动继承同名模型的能力。

这让目录的失效方式保持局部：一次网络刷新失败不阻止离线打开模型菜单，未知能力也不会伪装成确定承诺。

源码：[内建定义](../../../agent/infrastructure/llm/catalog.py)、[缓存和能力解析](../../../agent/infrastructure/llm/provider_service.py)。验证：[目录](../../../test/test_model_catalog.py)、[刷新与端点隔离](../../../test/test_model_cache_refresh.py)。关联：[上下文预算](../02-context/context-budget.zh-CN.md)、[图片输入](../02-context/image-input.zh-CN.md)。

[返回系列地图](../README.zh-CN.md)
