# 工具结果：同一事实，不同阅读预算

English | [简体中文](tool-results.md)

模型需要足够做下一步的证据；终端需要可扫读的结果；大型输出还需要能继续查阅的文件。Rind 在结果边界生成不同投影，避免三者互相拖累。

~~~mermaid
flowchart TB
    RAW["工具结构化结果"] --> N["ToolResultNormalizer"]
    N --> UI["terminal_content<br/>展示预算"]
    N --> MODEL["model_content<br/>模型预算"]
    N --> DISK[("必要时写 tool-output<br/>返回文件引用")]
    MODEL --> HISTORY[("保存模型投影")]
    HISTORY --> NEXT["下一次模型上下文"]
~~~

统一 payload 使用 ok、tool、data 或 error，并可带 error_type、meta、attachments。Normalizer 默认终端预算 8 KiB，模型预览 25 KiB / 2,000 行；限制按最终 UTF-8 JSON 计量。附件引用单独保留，不因为正文截断丢失图片。

| 结果类型 | 特殊规则 |
| --- | --- |
| read_file | 只保留连续完整行，next_offset 指向首个未显示行；不能用首尾拼接假装读过中间部分。 |
| edit_file / write_file | 模型拿位置与修改统计；有界 diff 留在工具记录和展示路径，避免重复占用上下文。 |
| 受管任务 | 状态、task_id、输出路径与分页提示一起保留；预览缩短后不保留误导性的续读位置。 |
| 一般超长结果 | 可写输出文件，预览明确标记截断并给出继续读取路径。 |

已保存的 model_content 是重放依据，后续显示规则变化不会重新裁剪旧会话。完整输出也不是无限保证：Shell 有独立输出配额和过期清理，缺失时必须报告原因。

代码入口：[结果归一化](../../../agent/application/tools/result_normalizer.py)、[结果契约](../../../agent/domain/tool_result.py)、[输出存储](../../../agent/infrastructure/persistence/tool_output_store.py)。验证：[归一化测试](../../../test/test_tool_result_normalizer.py)、[文件分页](../../../test/test_file_paging.py)。

[返回系列地图](../README.zh-CN.md)
