# Model adapters: narrowing provider protocols into two kinds of calls

English | [简体中文](provider-adapters.zh-CN.md)

The execution kernel depends only on ChatClient: `create` returns a complete `ModelCompletion`, `stream` produces `ModelStreamEvent`s, and `close` releases the connection. Ordinary turns use the streaming call; a compaction summary can use the complete call with a request-level output cap. The provider's message format, tool arguments, and finish reasons are converted in the adapter layer.

~~~mermaid
flowchart LR
    R["TurnRunner / compaction service"] --> I["ChatClient<br/>create · stream · close"]
    P["ProviderService<br/>credentials + endpoint + model selection"] --> I
    I --> C["OpenAI Chat"]
    I --> O["OpenAI Responses"]
    I --> A["Anthropic Messages"]
    I --> G["Google Generative AI"]
    C & O & A & G --> E["ModelCompletion / ModelStreamEvent"]
    E --> R
~~~

## What one call goes through

1. ProviderService resolves the credentials, endpoint, model, and reasoning effort, then creates the client according to the api the provider defines.
2. The adapter converts internal messages and tool declarations into the remote format; images are converted here into the data the provider needs, and the remote side never sees local file paths.
3. Streaming increments are handed to the kernel to parse uniformly; tool arguments can arrive in chunks, and no single fragment may be treated as a complete tool call.
4. Finish reasons, usage, and errors return as unified model types; the client is closed when the container is released.

A unified interface does not mean every provider offers the same features. Image capability, context window, and the supported efforts come from the [model catalog](model-catalog.md); LongCat clears the generic reasoning_effort to avoid sending an unsupported field. The branch that creates the client looks at definition.api; the api in the general settings is also used for catalog metadata and refresh decisions, so one cannot infer that any api value can switch adapters.

## Cancellation and retries each have their own boundary

The shared cancellation helper waits on the next item and the cancellation signal at the same time, and when both are ready, cancellation wins; on exit, it cleans up the active read task and the subscription. This way, upper layers do not have to rewrite the cancellation race logic for every SDK.

Retry policy still differs by provider: the Chat client's OpenAI SDK is configured with max_retries=14, while Responses uses the default constructor value of 2; model catalog refresh separately uses 0 SDK retries and a 10-second overall limit. These cannot be merged into a claim that "the kernel retries N times uniformly". Protocol compatibility also does not guarantee that a model calls tools correctly; behavior verification still has to distinguish local simulation from real providers.

Source code: [the port](../../../agent/application/ports/chat_client.py), [client assembly](../../../agent/infrastructure/llm/provider_service.py), [Chat](../../../agent/infrastructure/llm/openai_chat.py), [Responses](../../../agent/infrastructure/llm/openai_responses.py), [Anthropic](../../../agent/infrastructure/llm/anthropic_messages.py), [Google](../../../agent/infrastructure/llm/google_generative_ai.py), [the cancellation helper](../../../agent/infrastructure/llm/cancellation.py). Verification: [provider lifecycle](../../../test/test_provider_lifecycle.py), [fake provider integration](../../../test/test_provider_e2e.py).

[Back to the series map](../README.md)
