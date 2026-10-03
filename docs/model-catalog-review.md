# Model catalog review — 2026-10-03

The offline catalog contains 33 provider entries and 148 model entries (including
separate regions/products). It is a curated fallback, not an exhaustive inventory
or a promise of account access. Review covers exact IDs, image input, context
limits and the reasoning-effort values represented by Rind's existing adapters.
Official documentation takes precedence over secondary indexes. Some legacy
models and exact numeric limits rely on models.dev; they are not all independently
verified against official documentation. This is a dated snapshot.

## LongCat

Select **LongCat** in `/login`, then select a model in `/model`. Alternatively,
configure the host's settings and set `LONGCAT_API_KEY` in its environment:

```json
{
  "provider": "longcat",
  "model": "LongCat-2.5-Preview",
  "apiKey": "$LONGCAT_API_KEY"
}
```

The default base URL is `https://api.longcat.chat/openai/v1`; the shared OpenAI
Chat adapter appends `/chat/completions`. Credentials are stored independently
of OpenAI and other providers. Mobile uses the remote host's provider settings
and catalog; it does not need its own model runtime or a rebuilt APK.

| Exact API ID | Image input | Context tokens | Effort levels |
| --- | --- | --- | --- |
| `LongCat-2.5-Preview` | Yes | 1,048,576 | None exposed |
| `LongCat-2.0` | No | 1,000,000 | None exposed |

Both document tool calling and a `thinking.type` enabled/disabled toggle, rather
than OpenAI `reasoning_effort` levels. Rind leaves thinking at the provider default;
this change does not add a thinking toggle. The native LongCat entry suppresses
saved effort values inherited from another model.

Sources and discrepancies:

- [Quickstart](https://longcat.chat/platform/docs/zh/),
  [Chat API](https://longcat.chat/platform/docs/zh/api/chat),
  [Models API](https://longcat.chat/platform/docs/zh/api/models), and
  [Codex integration](https://longcat.chat/platform/docs/zh/codex).
  The quickstart's SDK base-URL example omits `/v1`; explicit HTTP paths and the
  Codex configuration confirm `/openai/v1`.
- [Model details](https://longcat.chat/platform/docs/zh/api/model) gives 1,048,576
  for 2.5, but its example still lists text-only input. The newer
  [changelog](https://longcat.chat/platform/docs/zh/change-log) announces image
  input on 2026-09-25 and takes precedence. It also records the old Flash models'
  retirement on 2026-05-29; those IDs are not advertised.
- [2.5 pricing](https://longcat.chat/platform/docs/zh/pricing/longcat-2.5),
  [2.0 pricing](https://longcat.chat/platform/docs/zh/pricing/longcat-2.0), and
  [OpenCode integration](https://longcat.chat/platform/docs/zh/open-code).
  Official documentation describes the context as 1M; the exact 2.0 value
  1,000,000 comes from the current models.dev entry.

## Sources for the refreshed catalog

The following sources were fetched during this review. Exact product/region
matching matters: similarly named models hosted elsewhere can have different
limits or modalities. Official pages below establish current families and
documented capabilities; models.dev supplements exact IDs, older entries and
numeric limits where those pages do not enumerate them.

| Family | Primary references and scope |
| --- | --- |
| OpenAI | [Models](https://developers.openai.com/api/docs/models.md), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra.md), [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna.md). These official pages were successfully fetched, superseding the earlier review's HTTP 403 limitation. |
| Anthropic | [Model overview](https://platform.claude.com/docs/en/models/overview), including Opus/Sonnet 5.5. Effort controls remain unexposed by the existing adapter. |
| Google | [Models](https://ai.google.dev/gemini-api/docs/models), [Gemini 3.8](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash); updated Flash variants, exact limits supplemented by models.dev. |
| DeepSeek | [Models/pricing](https://api-docs.deepseek.com/quick_start/pricing/), [thinking](https://api-docs.deepseek.com/guides/thinking_mode/): current Flash vision and low/high/max efforts; direct and third-party hosting remain distinct. |
| Groq | [Models](https://console.groq.com/docs/models), [reasoning](https://console.groq.com/docs/reasoning), [API](https://console.groq.com/docs/api-reference#models). |
| Mistral | [Documentation index](https://docs.mistral.ai/llms.txt), [reasoning](https://docs.mistral.ai/studio/conversations/reasoning.md), [model schema](https://github.com/mistralai/client-python/blob/main/src/mistralai/client/models/basemodelcard.py); model limits supplemented by models.dev. |
| Z.AI / Zhipu | [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3.md), [Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash.md), [Coding Plan](https://docs.z.ai/devpack/overview.md), [Chat API](https://docs.z.ai/api-reference/llm/chat-completion.md); regional/product lists from models.dev. |
| Kimi / Moonshot | [K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [Kimi Code](https://www.kimi.com/code/docs/en/kimi-code/models.html); global/CN exact lists from models.dev. |
| Qwen | [China model list](https://help.aliyun.com/zh/model-studio/models), [China Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-overview). Beijing Token Plan is not the Singapore or separate Coding Plan product. |
| xAI | [Models](https://docs.x.ai/developers/models), [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning); Grok 4.7 added. |
| MiMo | [Models](https://mimo.mi.com/docs/en-US/quick-start/summary/model); regular and regional Token Plans retain separate credentials. |
| Tencent | [TokenHub models](https://cloud.tencent.com/document/product/1823/130051), [Token Plan](https://cloud.tencent.com/document/product/1823/130060), [Coding Plan](https://cloud.tencent.com/document/product/1823/130092), [legacy migration](https://cloud.tencent.com/document/product/1729/111007). Exact limits supplemented by models.dev; legacy Hunyuan context remains unknown. |
| Ark | Official pages returned a JavaScript shell during this review. Current model IDs/limits use the exact `volcengine` and `volcengine-coding-plan` models.dev entries; Coding Plan now uses `doubao-seed-2.1-turbo`. `ark-code-latest` has unknown image/context metadata because selection is console-dependent. Earlier endpoint references are in [provider notes](provider-catalog.md). |
| MiniMax | [Anthropic compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api): M3, images, 1,000,000 tokens. Always-thinking M2.x/M3.1 Flash Preview are not newly advertised because the adapter does not preserve full signed thinking blocks. |
| OpenRouter | [Public model catalog](https://openrouter.ai/api/v1/models), [reasoning parameters](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). Hosted model metadata is independent of original-provider metadata; nested reasoning controls are not implemented by Rind's shared Chat adapter, so effort levels are unexposed. |

Secondary source: [models.dev JSON](https://models.dev/api.json), downloaded
2026-10-03, SHA-256
`26af09eea592f732302063c520c32bf1939ae0747a75614178c065fd661311b6`.
OpenRouter snapshot SHA-256:
`17f5cbde8c7bbac639e17cabd2f90dcb82499e9b6bbff38d234ca0c7129b96c2`.
These are provenance fingerprints, not runtime download dependencies.

Important models.dev mappings: `zhipu` → `zhipuai`, `zai-coding` →
`zai-coding-plan`, `zhipu-coding` → `zhipuai-coding-plan`, `kimi-coding` →
`kimi-code-plan-global`, `moonshot`/`moonshot-cn` → `moonshotai`/`moonshotai-cn`,
`qwen` → `alibaba-cn`, `qwen-coding` → `alibaba-token-plan-cn`.

## Resolution, refresh and compatibility

- Valid metadata cached for the same endpoint takes precedence over built-in
  values. Official fallback metadata requires an exact model and matching
  official endpoint. Custom proxies cannot inherit capabilities by model name.
  Generic `openai-compatible` can inherit image/context metadata at a matching
  official endpoint without changing its configured API dialect or provider.
- Context discovery reads only verified fields: OpenRouter `context_length`,
  Mistral `max_context_length`, Groq `context_window`. Only positive integers
  count. Missing/invalid fields preserve existing values only for the same
  endpoint and model. Built-in defaults are not written into remote caches.
- Ordinary list reads are offline. Login, explicit `model/list` RPC with
  `{"refresh": true}`, and startup stale-cache refresh share the existing fetch
  path. Startup refresh uses the existing 24-hour TTL; it does not download a
  new built-in catalog or probe model generation.
- Removed unverified fallback IDs: `claude-3-5-haiku-latest`, `gemini-3-flash`,
  `deepseek-chat`, `deepseek-reasoner`, and Qwen Coding's `qwen3-coder-plus` /
  `qwen3-coder-flash`. Explicitly configured custom/legacy model IDs remain
  usable and listed. Removal is not a claim that every account rejects them.
- Reasoning budgets/toggles are not equivalent to effort enums. Metadata lists
  only implemented effort values; this change does not redesign the existing
  desktop/web effort menus or implement new provider thinking controls.
- Context limits are exposed catalog metadata, not automatically applied
  compaction budgets. Modality support does not guarantee every adapter-specific
  thinking/tool-history combination; the Anthropic adapter's signed-thinking
  persistence limitation remains and requires separate work.

## Validation

The focused Python regression run passed **265 tests** on 2026-10-03:
`test_model_catalog`, `test_provider_auth`, `test_model_cache_refresh`,
`test_provider_e2e`, `test_provider_lifecycle`, `test_image_requests`,
`test_image_attachments`, `test_settings_loader`, `test_agent_architecture`, and
`test_runtime_server_protocol`. `git diff --check` also passed.

Tests use isolated credentials, local fake providers and actual SDKs with mock
HTTP transports. LongCat coverage includes login, model discovery, authentication,
exact paths, streamed reasoning/tool calls, tool-result replay and suppression of
unsupported effort fields. Other tests cover context precedence, proxy isolation,
refresh merging and existing provider/image/settings/runtime behavior.

The unauthenticated LongCat models endpoint returned HTTP 401, confirming
reachability only. No paid generation or authenticated live LongCat acceptance
test was performed. Restart the host Worker/Desktop to load the updated Python
catalog; mobile receives its provider/model list from that host.
