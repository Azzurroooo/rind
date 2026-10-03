# MiMo, Hunyuan, Doubao, MiniMax and LongCat providers

Original additions reviewed on 2026-09-24; the [2026-10-03 catalog review](model-catalog-review.md)
records current sources and verification boundaries, including secondary Ark evidence. Use `/login` to select
an entry and save its key, then `/model` to select a model. Each entry has an
independent stored credential and environment variable; logging in to one does
not configure its siblings. Environment variable names below are Rind settings.

Models are identified and displayed by their API IDs throughout Rind. The model
catalog, runtime responses and refreshed cache have no separate display-name
field; names from provider responses or older caches are ignored.

| Provider | Product / region | Base URL | Environment variable |
| --- | --- | --- | --- |
| `longcat` | LongCat API | `https://api.longcat.chat/openai/v1` | `LONGCAT_API_KEY` |
| `xiaomi` | Xiaomi MiMo API | `https://api.xiaomimimo.com/v1` | `XIAOMI_API_KEY` |
| `xiaomi-token-plan-cn` | MiMo Token Plan, China | `https://token-plan-cn.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-ams` | MiMo Token Plan, Europe | `https://token-plan-ams.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-sgp` | MiMo Token Plan, Singapore | `https://token-plan-sgp.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `hunyuan` | Tencent Hunyuan, existing accounts | `https://api.hunyuan.cloud.tencent.com/v1` | `HUNYUAN_API_KEY` |
| `tencent-tokenhub` | Tencent TokenHub, current Hunyuan models | `https://tokenhub.tencentmaas.com/v1` | `TENCENT_TOKENHUB_API_KEY` |
| `tencent-token-plan` | Tencent Token Plan | `https://api.lkeap.cloud.tencent.com/plan/v3` | `TENCENT_TOKEN_PLAN_API_KEY` |
| `tencent-coding-plan` | Tencent Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` | `TENCENT_CODING_PLAN_API_KEY` |
| `volcengine` | Doubao / Volcengine Ark API | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` |
| `volcengine-coding-plan` | Ark Coding Plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `ARK_CODING_PLAN_API_KEY` |
| `minimax` | MiniMax API, global | `https://api.minimax.io/anthropic` | `MINIMAX_API_KEY` |
| `minimax-cn` | MiniMax API, China | `https://api.minimax.cn/anthropic` | `MINIMAX_CN_API_KEY` |
| `minimax-coding-plan` | MiniMax Token Plan, global | `https://api.minimax.io/anthropic` | `MINIMAX_CODING_PLAN_API_KEY` |
| `minimax-cn-coding-plan` | MiniMax Token Plan, China | `https://api.minimax.cn/anthropic` | `MINIMAX_CN_CODING_PLAN_API_KEY` |

MiniMax uses the existing Anthropic Messages adapter. Its Python SDK appends
`/v1/messages`, so the configured base URL must end at `/anthropic`. All other
entries use the existing OpenAI Chat adapter and Bearer API-key authentication.
MiMo documents both `api-key` and Bearer headers; the existing SDK uses Bearer.

## Product and model boundaries

- LongCat includes `LongCat-2.5-Preview` (images) and `LongCat-2.0` (text).
  Both use provider-default thinking; a saved OpenAI effort value is not sent.
  See the [review](model-catalog-review.md#longcat) for current official sources
  and the base-URL/example discrepancy.
- MiMo API keys (`sk-`) and Token Plan keys (`tp-` / `ttp-`) are separate. The
  fallback list contains MiMo V2.6 Pro and Flash, documented for both products.
- Tencent's legacy Hunyuan platform is migrating to TokenHub. New accounts
  should use `tencent-tokenhub`; the legacy entry retains `hunyuan-turbos-latest`.
  TokenHub and Token Plan include Hy3 and Hy4 Preview. Coding Plan currently
  documents `tc-code-latest` and `glm-5`; older aggregated lists are not reused.
- Ark API and Coding Plan use different endpoints and billing. The regular
  fallback is `doubao-seed-2-1-pro-260628`; Coding Plan uses `doubao-seed-2.1-turbo`
  and its console-selected alias, based on the current secondary index.
  `ark-code-latest` follows the model selected in the console; its image support
  remains unknown because the selected model can change. Accounts using custom
  inference endpoints can set the `ep-...` model ID in their settings.
- MiniMax Token Plan uses a **Subscription Key**, which its official docs say
  is not interchangeable with pay-as-you-go API Keys. Separate entries prevent
  one login from overwriting the other, even though their URLs are identical.
- MiniMax's fallback is M3, which supports images and defaults to thinking off.
  M2.x and M3.1 Flash Preview require returning complete thinking blocks across tool turns;
  Rind's current Anthropic adapter does not preserve these blocks, so these models are
  not advertised in this fallback list. No unsupported effort levels are exposed.

Model lists are small offline fallbacks, not claims that every account has
access to every model. Existing model discovery remains best-effort. No new
runtime dependencies or SDKs are added. LongCat suppresses unsupported effort
fields before constructing the existing Chat adapter.

## Official sources

- [MiMo first API call](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call),
  [models](https://mimo.mi.com/docs/en-US/quick-start/summary/model),
  [OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api), and
  [Token Plan](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription).
  The platform links to this documentation site; its published documentation
  chunks were read because the initial HTML is a JavaScript shell.
- [Hunyuan OpenAI compatibility](https://cloud.tencent.com/document/product/1729/111007).
- [TokenHub quickstart](https://cloud.tencent.com/document/product/1823/130058),
  [models](https://cloud.tencent.com/document/product/1823/130051),
  [Token Plan](https://cloud.tencent.com/document/product/1823/130060), and
  [Tencent Coding Plan](https://cloud.tencent.com/document/product/1772/128947).
- [Ark base URL and authentication](https://www.volcengine.com/docs/ark/base-url-and-authentication),
  [image understanding](https://www.volcengine.com/docs/ark/image-understanding),
  and [Coding Plan](https://www.volcengine.com/docs/82379/1928261).
- [MiniMax Anthropic SDK, global](https://platform.minimax.io/docs/api-reference/text-anthropic-api),
  [China](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api), and
  [Token Plan keys](https://platform.minimax.io/docs/token-plan/intro).

Verification uses isolated credentials and mocked SDK transports for login,
request paths, authentication and credential separation. No live model requests
were made; real-account availability is not claimed.
