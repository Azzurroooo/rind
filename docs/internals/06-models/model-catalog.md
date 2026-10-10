# Model catalog: choose a model, and resolve capabilities

English | [简体中文](model-catalog.zh-CN.md)

The catalog serves the /model menu and also gives the kernel image_input and context_window. Similar model names are not proof of identical capabilities: a match is based on the endpoint and the exact model ID.

~~~mermaid
flowchart TD
    S["current provider + endpoint + model ID"] --> C{"same-endpoint cache with valid capabilities?"}
    C -->|"yes"| V["use the cached fields"]
    C -->|"missing field"| B{"exact match on official endpoint and built-in ID?"}
    B -->|"yes"| F["fill in the built-in capabilities"]
    B -->|"no"| U["keep unknown"]
    V & F & U --> R["model capabilities<br/>image filtering / context budget"]
    T["explicit refresh / background refresh on first initialization"] --> N["remote models.list"]
    N -->|"success and non-empty"| W["replace that catalog's cache"]
    N -->|"failure or invalid"| K["keep the existing cache"]
~~~

## Reads and refreshes are separate

An ordinary list_models sends no HTTP request; only an explicit refresh pulls actively, and initialization also schedules one refresh for a stale cache. The 24-hour TTL is a refresh condition, **not a read deadline**: as long as the endpoint matches, an expired cache still serves the catalog. A failed refresh returns a notice and keeps showing the already-saved models.

A successful refresh treats the new list as authoritative, and models the remote side deleted are no longer mixed in. Old capability fields are reused only under the same endpoint and the same ID; an empty list, exceptions, and invalid IDs do not overwrite the old cache. Even when the currently selected model is not in the enumerated list, the catalog still adds that selection, so custom models can be displayed.

## Three-state capabilities are more reliable than guessing

| Field | What a known value does | When unknown |
| --- | --- | --- |
| image_input | false omits images; true lets the adapter submit them | Keeps the attempt path; does not assume support from the name |
| context_window | Provides the window for the session context budget | Uses the kernel's default window |
| reasoning_efforts | Constrains the levels available to the menu and the adapter | Does not invent levels from the model name |

Remote fields are read in the formats each provider already implements: for example OpenRouter's architecture.input_modalities/context_length, Mistral's capabilities.vision/max_context_length, and Groq's context_window. The built-in fallback requires the official endpoint to match; a generic compatible endpoint can also match a known official catalog, and the DeepSeek root endpoint additionally has /v1 normalization. After switching to a proxy endpoint, a same-named model must not automatically inherit its capabilities.

This keeps the catalog's failure modes local: one failed network refresh does not prevent the model menu from being opened offline, and unknown capabilities do not masquerade as definite promises.

Source code: [built-in definitions](../../../agent/infrastructure/llm/catalog.py), [cache and capability resolution](../../../agent/infrastructure/llm/provider_service.py). Verification: [catalog](../../../test/test_model_catalog.py), [refresh and endpoint isolation](../../../test/test_model_cache_refresh.py). Related: [context budget](../02-context/context-budget.md), [image input](../02-context/image-input.md).

[Back to the series map](../README.md)
