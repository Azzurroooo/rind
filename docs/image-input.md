# Image input

Ask Rind to read a local image, for example `Read screenshots/chart.png and explain the axes`. The existing `read_file` tool handles both text and images. A user input containing `uploads/chart.png` imports that image when the input enters history, including steering and follow-up input. Ordinary paths in user text require a tool read. Image line pagination is rejected.

PNG, JPEG, WebP, GIF and BMP are accepted. Animated images use the first frame with a visible notice. Rind corrects EXIF orientation, preserves transparency, strips metadata and fits images within a 2000-pixel longest edge. Sources are limited to 20 MiB and 40 million pixels; each normalized PNG/JPEG is at most 3 MiB. Requests, including historical images, allow up to eight images and 16 MiB of base64 data. These are Rind scheduling limits, not provider billing or quality guarantees.

`/model` shows image input as supported, unsupported or unknown. Unknown allows the actual task with a notice. Unsupported rejects image tool reads and explicitly labels historical images as not sent. Changing back to a vision model restores image input. A rejected provider request reports the reason; Rind never silently retries it without pictures. The terminal displays text summaries, not bitmap previews. `rind run` keeps notices on stderr and the final assistant response on stdout.

## Snapshots and boundaries

Images are captured under `<session>/attachments/<sha256>.png|jpg`. Hashes identify the normalized bytes. JSONL stores only `path`, `mime_type`, `width`, `height`, `size_bytes`; no base64. User messages own their references and new user inputs always have `attachments`, including `[]`. Tool records own tool attachments; projected tool messages resolve them by call ID.

Deleting or changing the source does not affect recorded images. Missing or corrupt snapshots require a new read. Older uploads references without snapshots are not silently reread; the resume preview explains that the user must resend them. Forks copy only retained messages' and tools' snapshots, independently of the source session. Deleting a session removes its attachments.

Normal and compact requests use the same application preparation function. It validates the selected image budget and loads through the session port, producing temporary `{mime_type, data: bytes}` images. Adapters receive bytes and never access workspace paths. Bounded image I/O runs in worker threads; cancellation waits for an in-flight Pillow operation to settle. Temporary files are removed on exceptions and cancellation. A process crash between atomic image publication and the JSONL append can leave an unreferenced file; session deletion removes it. There is no cross-session image store or garbage collector.

Context estimation adds `ceil(width/32) * ceil(height/32) * 2` per image, separately from text. This is a working estimate, not a provider token formula. Older history is compacted when it exceeds request limits; an oversized current message or tool group fails explicitly. Compact requests over the image limit use prior observations and references and mark that pictures were not re-examined. The handoff retains absolute snapshot paths for `read_file`; a fork updates those paths. Compacted images are not automatically attached again.

| API | Image serialization |
| --- | --- |
| Chat Completions | User text/image_url blocks; tool images follow the entire tool-result group in a synthetic user message, labelled by call ID and image index. |
| Responses | input_text/input_image blocks, including function_call_output.output arrays. |
| Anthropic Messages | Base64 image blocks inside user content or tool_result.content, preserving tool_use_id and errors. |
| Google Generative AI | SDK inline_data bytes become inlineData/base64 in HTTP JSON; tool images follow the full function-response group. |

Synthetic messages exist only during request conversion. Trace serialization redacts image bytes, data URLs and provider base64 blocks; provider errors also redact echoed payloads. Conversion and redaction operate on copies.

## Capability maintenance

Resolution is endpoint-matched cache boolean → verified built-in value at the official endpoint → unknown. False is an explicit value. Expired caches remain usable at matching endpoints. Custom endpoints cannot inherit the official model's capability by name. Built-in defaults are never stamped into remote cache data.

The generic `openai-compatible` provider also uses the catalog when its configured endpoint exactly matches an official service. It keeps its configured provider and API; only image capability is resolved from that service's exact model ID. DeepSeek's documented root URL `https://api.deepseek.com` and the existing `/v1` URL both match the DeepSeek catalog; trailing slashes are ignored for this lookup. Other paths, proxy hosts and unknown models remain unknown. Cache matching remains exact, so no cached metadata is transferred between addresses.

Background refresh, login and explicit list refresh share one fetch/parser/merge path. A valid remote boolean replaces the old value; omitted/invalid metadata preserves the old boolean only for the same endpoint and ID. Removed models disappear, failed/empty responses preserve the entire cache. Refresh uses the existing ten-second deadline without SDK retries. Ordinary list reads stay offline. There are no generation probes or extra capability requests.

Verified discovery schemas:

- [OpenRouter model list](https://openrouter.ai/docs/api/api-reference/models/get-models): `architecture.input_modalities`, a nonempty complete list of strings; `image` means true, its absence means false.
- [Mistral model list](https://docs.mistral.ai/api/endpoint/models): boolean `capabilities.vision`.
- Other existing discovery APIs do not provide an implemented, verified capability schema and fall back locally.

The built-in [catalog](../agent/infrastructure/llm/catalog.py) contains 122 provider/model entries across 17 named providers: 84 support images, 32 do not, and six retained legacy entries are unverified. The 2026-09-21 update added 90 entries. Every explicit capability was checked against the sources below; these are development-time references, not runtime dependencies. The generic provider has no duplicate model list. No wildcard model-name rules are used.

Representative entries (the code contains the complete exact-ID list):

| Provider | Supports images | Does not support images |
| --- | --- | --- |
| OpenAI | GPT-6 Astra, GPT-5.6 Sol/Terra/Luna, GPT-5.5/5.4, GPT-4.1/4o, o3, o4-mini | o3-mini |
| Anthropic | Fable 5.1, Opus 5/4.8/4.6, Sonnet 5/4.6, Haiku 4.5 | — |
| Google | Gemini 3.8/3.5 Flash, 3.1 Pro Preview/Flash Lite, 3 Flash Preview, 2.5 Pro/Flash | — |
| DeepSeek | deepseek-flash, deepseek-v4-flash, deepseek-v4-flash-vision-exp | deepseek-v4-pro |
| Groq | qwen/qwen3.8-27b | Llama 3.3 70B/3.1 8B, GPT-OSS 120B/20B |
| Mistral | Mistral Large/Medium/Small latest, Pixtral Large latest | Devstral Medium/Devstral latest, Codestral latest |
| Z.AI and Zhipu regular endpoints | GLM-5.3 Flash/FlashX, GLM-5V Turbo, GLM-4.6V | GLM-5.3/5.2/4.7 |
| Z.AI Coding | GLM-5.3 Flash | GLM-5.3/5.3 Highspeed/5.2/4.7 |
| Zhipu Coding | GLM-5.3 Flash, GLM-4.6V | GLM-5.3/5.3 Highspeed |
| Kimi Coding | kimi-for-coding, kimi-for-coding-highspeed, k3, k3-256k | — |
| Moonshot global/CN | Kimi K3, K2.6, K2.7 Code/Code Highspeed | — |
| Qwen regular endpoint | Qwen3.8 Max/Flash, Qwen3.7/3.5 Plus, Qwen3 VL Plus, Qwen VL Max | Qwen3.7 Max, Qwen3 Coder Plus, Qwen Max/Plus/Flash |
| Qwen Coding (Beijing Token Plan endpoint) | Qwen3.8 Max/Flash, Qwen3.7/3.6 Plus, DeepSeek V4.1 Flash, Kimi K2.7 Code | Qwen3.7 Max, DeepSeek V4 Flash/V4 Pro, GLM-5.3 |
| xAI | Grok 4.6/4.5/4.3, Grok Build 0.1, Grok 4.20 0309 reasoning/non-reasoning | — |
| OpenRouter | GPT-5.5, Claude Sonnet/Opus 4.6, Gemini 3.1 Pro Preview, DeepSeek V4.1 Flash, Kimi K3, Qwen3.6 Plus | deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro |

Sources and endpoint distinctions:

- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing) explicitly mark Flash as vision-capable and V4 Pro as unsupported. The old official Flash aliases now route to V4.1 Flash. [First API call](https://api-docs.deepseek.com/) documents the root URL. This does **not** transfer to Qwen/OpenRouter's separately hosted V4 Flash, whose own catalogs still declare text-only input.
- Pi checkout `890f92088` (2026-09-21), `packages/ai/scripts/generate-models.ts`, explicitly defines the current DeepSeek and OpenAI models and consumes [models.dev](https://models.dev/api.json) for other providers. The local checkout has generated TypeScript wrappers but no generated provider JSON, so the referenced public source was fetched and checked directly. OpenAI's official model pages returned HTTP 403 here; its capability entries are supported by Pi and models.dev, not a claimed successful documentation fetch.
- For models.dev, `zhipu` maps to `zhipuai`, `zai-coding` to `zai-coding-plan`, `zhipu-coding` to `zhipuai-coding-plan`, `kimi-coding` to `kimi-code-plan-global`, and `moonshot`/`moonshot-cn` to `moonshotai`/`moonshotai-cn`. Pi supplies the Kimi Anthropic endpoint mapping. Qwen uses **alibaba-cn**; Qwen Coding's configured Beijing Token Plan endpoint uses **alibaba-token-plan-cn**, not the separate Alibaba Coding Plan product.
- OpenRouter entries were checked against its [public model catalog](https://openrouter.ai/api/v1/models) and complete `architecture.input_modalities` lists, preserving its own provider-prefixed model IDs.

The retained unverified entries are `claude-3-5-haiku-latest`, `gemini-3-flash`, `deepseek-chat`, `deepseek-reasoner`, and Qwen Coding's `qwen3-coder-plus`/`qwen3-coder-flash`. Their exact IDs were absent from the corresponding current source. The last two no longer inherit text-only metadata from a different Alibaba product. They remain unknown rather than guessing availability or capability. Refreshed explicit metadata always takes precedence.

## Dependencies and validation

Pillow is the only new runtime dependency (`>=12.0.0`). PyPI provides CPython 3.12 wheels for Windows x64, macOS arm64/x64 and Linux x64. Sample 12.0.0 wheel downloads are approximately 6.68 MiB (Windows x64), 4.43 MiB (macOS arm64), and 6.71 MiB (manylinux x64). No external image converter, process or service is required.

The SDK contract tests use OpenAI 2.50.0, Anthropic 1.5.0 and google-genai 2.23.0. OpenAI's minimum is raised to the tested 2.50.0 because Responses function outputs require typed image content arrays. The declared minimum versions were also checked against the upstream source: [Anthropic 0.40.0 ToolResultBlockParam](https://github.com/anthropics/anthropic-sdk-python/blob/v0.40.0/src/anthropic/types/tool_result_block_param.py) includes ImageBlockParam, and [google-genai 1.0.0 types](https://github.com/googleapis/python-genai/blob/v1.0.0/google/genai/types.py) exposes inline_data with Blob.data bytes. Their dependency minimums are unchanged. Gemini's SDK wire encoding can use URL-safe base64, so tests verify decoded bytes rather than assuming one alphabet.

Deterministic tests cover actual image decoding, size limits, atomic writes, cancellation, text regression, SDK request serialization, capability precedence and all refresh entries, tool-to-next-request delivery, queued uploads, snapshot recovery/forks/deletion, image budgeting/compaction, and CLI/trace behavior. Tests use mock transports or local fake providers, isolated RIND_HOME and no live model calls. Passing them establishes protocol and lifecycle behavior; real model visual quality remains an explicitly requested manual acceptance scenario.

Verification on 2026-09-21: the full Python regression suite passed 1,233 tests with two skipped; the CLI suite passed 435 tests with one skipped. Python source parsing, dependency-direction checks, obsolete image-path checks and `git diff --check` also passed.

The subsequent fixed-catalog expansion passed 180 provider, image-request, settings and runtime-protocol regression tests with external connections disabled. All explicit catalog capabilities were compared with the fetched source data; existing models' reasoning settings were checked unchanged. This update required no generation requests.
