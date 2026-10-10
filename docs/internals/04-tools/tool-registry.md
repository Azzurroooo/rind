# ToolSpec: Binding Tool Implementation to the Public Contract

English | [简体中文](tool-registry.zh-CN.md)

The model sees the schema; the executor calls the function. ToolSpec binds both to a single definition, avoiding the split contract implied by "the docs say you can pass it, but the function does not accept it".

~~~mermaid
flowchart LR
    F["handler + parameter descriptions"] --> S["ToolSpec<br/>schema / is_async / normalize_arguments"]
    S --> C["build_builtin_tool_specs"]
    C --> R["DefaultToolRegistry"]
    R --> M["advertised schema → model"]
    R --> V["normalize → validate arguments → handler"]
~~~

ToolSpec derives the argument structure from the function signature, records whether the handler is async, and records which arguments may be passed in. The registry rejects tools with the same name; a tool with advertised=false can still be recovered by historical calls, but it is never published as a new capability. bash_output continues to support old sessions through exactly this narrow compatibility boundary.

Arguments first pass through normalize_arguments, and only then are required and unknown checked. Public argument errors return InvalidArguments and list the missing, unknown, and allowed fields; runtime-injected parameters such as _session_id and _cancellation_token never become part of the model schema. This order lets legacy aliases such as file_path be converted before validation, while still preventing unknown fields from slipping through.

Whether a tool exists depends on assembly: Goal tools are registered only when enabled, managed runs restrict the available tools through an adapter, and one-shot can disable user questions. The normal path for adding a tool is to define a ToolSpec, assemble it explicitly in the catalog, and cover the argument and result contract tests; there is no need to add a same-named branch to TurnRunner.

## Extension Points Are Also Constraints

The advertised schema determines what the model can request; the handler signature determines what the executor can pass; advertised determines what new turns can see. Historical compatibility can preserve execution capability only, without continuing to encourage the model to choose the old tool; runtime private parameters are injected by the system, and the model may not override them arbitrarily.

Adding a tool is therefore not only writing a function; it must also answer three questions: how the arguments are normalized, how success and failure form a structured result, and under which container configuration the tool is exposed. Large results and results carrying images then go through the unified normalization and attachment path, so that a single tool cannot bypass the whole system's output budget.

Code entry points: [ToolSpec](../../../agent/infrastructure/tools/spec.py), [catalog](../../../agent/infrastructure/tools/catalog.py), [registry](../../../agent/infrastructure/tools/registry.py). Verification: [registry tests](../../../test/test_tool_registry.py).

[Back to the series map](../README.md)
