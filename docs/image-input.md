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

Background refresh, login and explicit list refresh share one fetch/parser/merge path. A valid remote boolean replaces the old value; omitted/invalid metadata preserves the old boolean only for the same endpoint and ID. Removed models disappear, failed/empty responses preserve the entire cache. Refresh uses the existing ten-second deadline without SDK retries. Ordinary list reads stay offline. There are no generation probes or extra capability requests.

Verified discovery schemas:

- [OpenRouter model list](https://openrouter.ai/docs/api/api-reference/models/get-models): `architecture.input_modalities`, a nonempty complete list of strings; `image` means true, its absence means false.
- [Mistral model list](https://docs.mistral.ai/api/endpoint/models): boolean `capabilities.vision`.
- Other existing discovery APIs do not provide an implemented, verified capability schema and fall back locally.

The small built-in catalog was checked on 2026-09-21 against [models.dev](https://models.dev/api.json), the catalog source also used by Pi's generation script. This is a development-time reference, not a runtime dependency. Provider IDs were matched to their corresponding services; no wildcard model-name rules are used.

| Built-in provider/model | image_input |
| --- | --- |
| OpenAI: gpt-5.5, gpt-4o-mini | true |
| Anthropic: claude-sonnet-4-6 | true |
| Anthropic: claude-3-5-haiku-latest | unknown: exact legacy alias not in the current catalog |
| Google: gemini-3.1-pro-preview | true |
| Google: gemini-3-flash | unknown: exact alias not verified |
| DeepSeek: deepseek-chat, deepseek-reasoner | unknown: exact legacy aliases not in the current catalog |
| Groq: llama-3.3-70b-versatile, openai/gpt-oss-120b | false |
| Mistral: mistral-large-latest / devstral-medium-latest | true / false |
| Z.AI and Zhipu, regular/coding endpoints: glm-5.3, glm-5.2 where listed | false |
| Z.AI Coding and Zhipu Coding: glm-5.3-flash | true |
| Kimi Coding: kimi-for-coding, k3 | true |
| Moonshot global/CN: kimi-k3, kimi-k2.6 | true |
| Qwen regular/coding: qwen3-coder-plus, qwen3-coder-flash, qwen-max where listed | false |
| xAI: grok-4.5, grok-4.3 | true |
| OpenRouter / generic compatible endpoint | No built-in model capability; matching remote metadata or unknown |

For models.dev's provider naming, Rind's `zhipu*` maps to `zhipuai*`, `zai-coding` to `zai-coding-plan`, `kimi-coding` to `kimi-code-plan-global`, `moonshot*` to `moonshotai*`, and Qwen to Alibaba's corresponding catalog. The current [Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [DeepSeek models](https://api-docs.deepseek.com/quick_start/pricing) no longer list the exact legacy aliases still present in Rind. These remain unknown rather than assigning a capability from their old names. Aliases may change; explicit refreshed metadata takes precedence where available. OpenAI documentation returned HTTP 403 in this environment; OpenAI request shapes were checked against the installed SDK and its actual HTTP serialization, and capability values against the catalog above.

## Dependencies and validation

Pillow is the only new runtime dependency (`>=12.0.0`). PyPI provides CPython 3.12 wheels for Windows x64, macOS arm64/x64 and Linux x64. Sample 12.0.0 wheel downloads are approximately 6.68 MiB (Windows x64), 4.43 MiB (macOS arm64), and 6.71 MiB (manylinux x64). No external image converter, process or service is required.

The SDK contract tests use OpenAI 2.50.0, Anthropic 1.5.0 and google-genai 2.23.0. OpenAI's minimum is raised to the tested 2.50.0 because Responses function outputs require typed image content arrays. The declared minimum versions were also checked against the upstream source: [Anthropic 0.40.0 ToolResultBlockParam](https://github.com/anthropics/anthropic-sdk-python/blob/v0.40.0/src/anthropic/types/tool_result_block_param.py) includes ImageBlockParam, and [google-genai 1.0.0 types](https://github.com/googleapis/python-genai/blob/v1.0.0/google/genai/types.py) exposes inline_data with Blob.data bytes. Their dependency minimums are unchanged. Gemini's SDK wire encoding can use URL-safe base64, so tests verify decoded bytes rather than assuming one alphabet.

Deterministic tests cover actual image decoding, size limits, atomic writes, cancellation, text regression, SDK request serialization, capability precedence and all refresh entries, tool-to-next-request delivery, queued uploads, snapshot recovery/forks/deletion, image budgeting/compaction, and CLI/trace behavior. Tests use mock transports or local fake providers, isolated RIND_HOME and no live model calls. Passing them establishes protocol and lifecycle behavior; real model visual quality remains an explicitly requested manual acceptance scenario.

Verification on 2026-09-21: the full Python regression suite passed 1,233 tests with two skipped; the CLI suite passed 435 tests with one skipped. Python source parsing, dependency-direction checks, obsolete image-path checks and `git diff --check` also passed.
