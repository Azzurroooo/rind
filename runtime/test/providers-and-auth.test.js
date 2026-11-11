import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CancellationTokenSource,
  CancelledError,
  CredentialStore,
  PROVIDERS,
  ProviderError,
  ProviderServiceImpl,
  loadProviders,
  loadSettings,
  provider,
  saveCustomProvider,
} from "../dist/index.js";
import * as chatgptOAuth from "../dist/infrastructure/chatgpt-oauth.js";
import {
  HttpStatusError,
  chatMessages,
  imageDataUrl,
  isContextOverflow,
  makeTrace,
  parseSseEvents,
  promptCacheKey,
  providerError,
  redactImageText,
  rejectsPromptCacheKey,
  separateToolImages,
} from "../dist/infrastructure/llm/sse.js";

async function isLoopbackPortFree(port, host = "127.0.0.1") {
  return await new Promise(resolve => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

test("sse.ts: isContextOverflow and providerError classification, cancellation, and image redaction", () => {
  // True context overflow phrases & HTTP 413
  assert.equal(isContextOverflow("This model's maximum context length is 128000 tokens."), true);
  assert.equal(isContextOverflow("prompt is too long: 210000 tokens > 200000 maximum"), true);
  assert.equal(isContextOverflow("Input exceeds the context window of this model"), true);
  assert.equal(isContextOverflow("context_length_exceeded"), true);
  assert.equal(isContextOverflow("Request had too many tokens for context"), true);
  assert.equal(isContextOverflow("Payload Too Large", 413), true);

  // Rate-limit false positives MUST NOT be classified as context overflow
  assert.equal(isContextOverflow("too many tokens, please wait 15 seconds", 429), false);
  assert.equal(isContextOverflow("Too many tokens, please wait before retrying.", 400), false);
  assert.equal(isContextOverflow("Limit: 200000 tokens per minute exceeded", 429), false);
  assert.equal(isContextOverflow("rate_limit_exceeded: too many tokens", 429), false);
  assert.equal(isContextOverflow("ordinary validation failure", 400), false);

  // providerError classification: rejected (400/422 & context_length_exceeded)
  const badReq = providerError(new HttpStatusError(400, "400: invalid tool schema"));
  assert.equal(badReq.status, "rejected");
  assert.equal(badReq.code, "provider_rejected");

  const overflowErr = providerError(new HttpStatusError(400, "maximum context length exceeded"));
  assert.equal(overflowErr.status, "rejected");
  assert.equal(overflowErr.code, "context_length_exceeded");

  const rateLimit429 = providerError(
    new HttpStatusError(429, "too many tokens, please wait and retry"),
  );
  assert.equal(rateLimit429.status, "unavailable");
  assert.notEqual(rateLimit429.code, "context_length_exceeded");

  // Upgrades an existing ProviderError if its message indicates context overflow
  const upgraded = providerError(
    new ProviderError("prompt is too long for model", { status: "failed", code: "provider_error" }),
  );
  assert.equal(upgraded.status, "rejected");
  assert.equal(upgraded.code, "context_length_exceeded");

  // timed_out (408, 504, TimeoutError, text match)
  const gatewayTimeout = providerError(new HttpStatusError(504, "Gateway Timeout"));
  assert.equal(gatewayTimeout.status, "timed_out");
  const textTimeout = providerError(new Error("Upstream request timed out after 30s"));
  assert.equal(textTimeout.status, "timed_out");

  // unavailable (500/503, ECONNRESET/fetch failed, stream_interrupted)
  const server503 = providerError(new HttpStatusError(503, "Service Unavailable"));
  assert.equal(server503.status, "unavailable");
  const netErr = providerError(new Error("TypeError: fetch failed (ECONNRESET)"));
  assert.equal(netErr.status, "unavailable");
  const interrupted = providerError(new Error("premature close"), "stream_interrupted");
  assert.equal(interrupted.status, "unavailable");
  assert.equal(interrupted.code, "stream_interrupted");

  // failed (generic unexpected error)
  const genericFail = providerError(new Error("Unexpected JSON parse token at position 4"));
  assert.equal(genericFail.status, "failed");

  // Redacts base64 / data-URLs embedded inside provider error messages
  const rawBlob = "A".repeat(96) + "==";
  const scrubbedErr = providerError(
    new Error(`Invalid image data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== and blob ${rawBlob}`),
  );
  assert.match(scrubbedErr.message, /\[image data omitted\]/);
  assert.match(scrubbedErr.message, /\[encoded data omitted\]/);
  assert.equal(scrubbedErr.message.includes("iVBORw0KGgo"), false);
  assert.equal(scrubbedErr.message.includes(rawBlob), false);

  // Cancellation throws CancelledError instead of wrapping as ProviderError
  const cancelSource = new CancellationTokenSource();
  cancelSource.cancel("user hit esc");
  assert.throws(
    () => providerError(new Error("socket hang up"), null, cancelSource.token),
    CancelledError,
  );

  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  assert.throws(() => providerError(abortErr), CancelledError);
});

test("sse.ts: redactImageText, separateToolImages, chatMessages, promptCacheKey, and makeTrace JSONL byte redaction", async t => {
  const inlineUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";
  const longBase64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(4); // > 80 chars
  const redacted = redactImageText(`url=${inlineUrl} raw: ${longBase64} ok=shortToken123`);
  assert.equal(redacted, "url=[image data omitted] raw: [encoded data omitted] ok=shortToken123");

  // separateToolImages & chatMessages
  const img1 = { mime_type: "image/png", data: Buffer.from("png-one", "utf8") };
  const img2 = { mime_type: "image/webp", data: Buffer.from("webp-two", "utf8") };
  const rawMessages = [
    { role: "system", content: "You are helpful." },
    { role: "assistant", content: "", tool_calls: [{ id: "tc_1" }, { id: "tc_2" }] },
    { role: "tool", tool_call_id: "tc_1", content: '{"ok":true}', images: [img1] },
    { role: "tool", tool_call_id: "tc_2", content: '{"ok":true}', images: [img2] },
    { role: "assistant", content: "Checked screenshots." },
  ];

  const separated = separateToolImages(rawMessages);
  assert.equal(separated.length, 6);
  assert.equal("images" in separated[2], false);
  assert.equal("images" in separated[3], false);
  assert.equal(separated[4].role, "user");
  assert.equal(
    separated[4].content,
    "Images from tool results (in order):\nImage 1: tool call tc_1\nImage 2: tool call tc_2",
  );
  assert.equal(separated[4].images.length, 2);

  const formatted = chatMessages(rawMessages, { reasoning: true });
  assert.equal(formatted[1].reasoning_content, "");
  assert.equal(formatted[5].reasoning_content, "");
  assert.ok(Array.isArray(formatted[4].content));
  assert.equal(formatted[4].content[0].type, "text");
  assert.equal(formatted[4].content[1].type, "image_url");
  assert.equal(formatted[4].content[1].image_url.url, imageDataUrl(img1));
  assert.equal(formatted[4].content[2].image_url.url, imageDataUrl(img2));

  // promptCacheKey & rejectsPromptCacheKey
  const keyA1 = promptCacheKey("session-alpha");
  const keyA2 = promptCacheKey("session-alpha");
  const keyB = promptCacheKey("session-beta");
  assert.equal(keyA1, keyA2);
  assert.notEqual(keyA1, keyB);
  assert.match(keyA1, /^rind:[0-9a-f]{24}$/);
  assert.equal(rejectsPromptCacheKey(new Error("Unknown parameter: 'prompt_cache_key'.")), true);
  assert.equal(rejectsPromptCacheKey(new Error("extra_forbidden: prompt_cache_key")), true);
  assert.equal(rejectsPromptCacheKey(new Error("Invalid API key")), false);

  // makeTrace via RIND_LLM_TRACE_PATH writes JSONL with prefix_hashes and scrubs Buffer/Uint8Array
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-llm-trace-"));
  const traceFile = path.join(tmp, "traces", "calls.jsonl");
  const prevTrace = process.env.RIND_LLM_TRACE_PATH;
  delete process.env.RIND_LLM_TRACE_PATH;
  t.after(async () => {
    if (prevTrace === undefined) delete process.env.RIND_LLM_TRACE_PATH;
    else process.env.RIND_LLM_TRACE_PATH = prevTrace;
    await rm(tmp, { recursive: true, force: true });
  });

  assert.equal(makeTrace(), null);
  process.env.RIND_LLM_TRACE_PATH = traceFile;
  const trace = makeTrace();
  assert.ok(trace);

  trace.record(
    "openai-responses",
    "stream",
    {
      model: "gpt-5.4",
      prompt_cache_key: keyA1,
      reasoning: { effort: "high" },
      input: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi", raw_image: Buffer.from([1, 2, 3, 4, 5]) },
      ],
      tools: [{ name: "read_file" }, { function: { name: "bash" } }],
    },
    {
      sessionId: "session-alpha",
      baseUrl: "https://api.openai.com/v1",
      status: "ok",
      usage: { input_tokens: 42, raw_bytes: new Uint8Array([9, 8, 7]) },
    },
  );

  const lines = (await readFile(traceFile, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.session_id, "session-alpha");
  assert.equal(entry.api, "openai-responses");
  assert.equal(entry.prompt_cache_key, keyA1);
  assert.equal(entry.reasoning_effort, "high");
  assert.equal(entry.message_count, 2);
  assert.equal(entry.prefix_hashes.length, 2);
  assert.notEqual(entry.prefix_hashes[0], entry.prefix_hashes[1]);
  assert.deepEqual(entry.tool_names, ["read_file", "bash"]);
  assert.equal(entry.payload.input[1].raw_image, "<bytes:5>");
  assert.equal(entry.usage.raw_bytes, "<bytes:3>");
});

test("sse.ts: parseSseEvents handles multi-line data, CRLF, comments, split chunks, trailing EOF flush, and cancellation", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    ": keepalive comment\r\n",
    "event: response.output_text.delta\r\ndata: line-one\r\n",
    "data: line-two\r\n\r\n",
    "event: custom\ndata: first-",
    "part\n\n",
    "data: trailing-without-blank-line\n",
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const piece of chunks) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });

  const events = [];
  for await (const ev of parseSseEvents(new Response(stream))) {
    events.push(ev);
  }
  assert.deepEqual(events, [
    { event: "response.output_text.delta", data: "line-one\nline-two" },
    { event: "custom", data: "first-part" },
    { event: null, data: "trailing-without-blank-line" },
  ]);

  // Mid-stream cancellation via CancellationTokenSource
  const cancelSource = new CancellationTokenSource();
  const hangingStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: initial-event\n\n"));
    },
    pull() {
      return new Promise(() => {
        // Never resolves until cancelled
      });
    },
  });

  const receivedBeforeCancel = [];
  await assert.rejects(async () => {
    for await (const ev of parseSseEvents(new Response(hangingStream), cancelSource.token)) {
      receivedBeforeCancel.push(ev);
      cancelSource.cancel("abort sse");
    }
  }, CancelledError);
  assert.deepEqual(receivedBeforeCancel, [{ event: null, data: "initial-event" }]);
});

test("chatgpt-oauth.ts & CredentialStore: PKCE S256 challenge, atomic auth.json storage, expiry check, and mock fetch token refresh", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-oauth-creds-"));
  const authPath = path.join(tmp, "auth.json");
  const prevFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = prevFetch;
    await rm(tmp, { recursive: true, force: true });
  });

  // 1) CredentialStore atomic save / load / list / renew / delete
  const store = new CredentialStore(authPath);
  assert.equal(store.get("openai"), null);
  assert.deepEqual(store.list(), []);

  store.set("anthropic", { type: "api_key", key: "sk-ant-test" });
  store.set("openai", {
    type: "oauth",
    access: "acc-initial",
    refresh: "ref-initial",
    expires_at: 1700000000,
    client_id: "client_1",
  });
  assert.deepEqual(store.list(), [
    { provider_id: "anthropic", type: "api_key" },
    { provider_id: "openai", type: "oauth" },
  ]);
  assert.equal(store.get("anthropic").key, "sk-ant-test");
  assert.equal(store.get("openai").access, "acc-initial");

  // Ensure atomic write left zero .tmp files
  const filesInTmp = await readdir(tmp);
  assert.equal(filesInTmp.some(f => f.endsWith(".tmp")), false);

  assert.throws(() => store.set("  ", { type: "api_key", key: "k" }), /Provider id is required/);
  assert.throws(() => store.set("groq", { type: "api_key", key: "" }), /API key is required/);
  assert.equal(store.delete("anthropic"), true);
  assert.equal(store.delete("anthropic"), false);

  // Corrupt non-object auth.json is rejected cleanly
  const badAuthPath = path.join(tmp, "bad-auth.json");
  await writeFile(badAuthPath, "[]\n", "utf8");
  assert.throws(() => new CredentialStore(badAuthPath).list(), /Invalid auth\.json/);

  // 2) chatgptOAuth.expiring & chatgptOAuth.fresh & ProviderServiceImpl OAuth refresh persistence
  const nowSec = Math.trunc(Date.now() / 1000);
  const validCred = {
    type: "oauth",
    access: "still-fresh",
    refresh: "ref-1",
    expires_at: nowSec + chatgptOAuth.REFRESH_BEFORE_SECONDS + 600,
    client_id: "client_valid",
  };
  const expiringCred = {
    type: "oauth",
    access: "about-to-expire",
    refresh: "ref-expiring",
    expires_at: nowSec + 60,
    client_id: "client_exp",
  };
  assert.equal(chatgptOAuth.expiring(validCred), false);
  assert.equal(chatgptOAuth.expiring(expiringCred), true);

  let refreshCalls = 0;
  const responsePayloads = [];
  const seenAuthHeaders = [];
  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr === chatgptOAuth.TOKEN_URL) {
      refreshCalls += 1;
      const form = new URLSearchParams(String(init.body || ""));
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "ref-expiring");
      assert.equal(form.get("client_id"), "client_exp");
      assert.equal(form.get("resource"), chatgptOAuth.RESOURCE);
      return new Response(
        JSON.stringify({
          access_token: "acc-rotated-1",
          refresh_token: "ref-rotated-1",
          expires_in: 3600,
          scope: `openid ${chatgptOAuth.DIRECT_TOKEN_SCOPE}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.endsWith("/responses")) {
      seenAuthHeaders.push(init.headers?.Authorization || init.headers?.authorization);
      responsePayloads.push(JSON.parse(String(init.body || "{}")));
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "OAuth response ok" }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  // Fresh credential does not call fetch
  const untouched = await chatgptOAuth.fresh(validCred);
  assert.equal(untouched, validCred);
  assert.equal(refreshCalls, 0);

  // ProviderServiceImpl with expiring OAuth credential refreshes once, persists to auth.json,
  // reuses rotated token on second request, and sets store:false without max_output_tokens.
  store.set("openai", expiringCred);
  const service = new ProviderServiceImpl(store, PROVIDERS, async () => []);
  const client = await service.createChatClient(loadSettings(path.join(tmp, "settings.json")), {
    provider_id: "openai",
    model_id: "gpt-5.4",
    reasoning_effort: "low",
  });

  const res1 = await client.create([{ role: "user", content: "Hello 1" }], null, null, {
    maxOutputTokens: 512,
  });
  const res2 = await client.create([{ role: "user", content: "Hello 2" }], null, null, {
    maxOutputTokens: 512,
  });
  assert.equal(res1.content, "OAuth response ok");
  assert.equal(res2.content, "OAuth response ok");
  assert.equal(refreshCalls, 1, "Second request must reuse refreshed access token without re-fetching");
  assert.deepEqual(seenAuthHeaders, ["Bearer acc-rotated-1", "Bearer acc-rotated-1"]);
  assert.equal(responsePayloads[0].store, false);
  assert.equal("max_output_tokens" in responsePayloads[0], false);
  assert.equal(store.get("openai").access, "acc-rotated-1");
  assert.equal(store.get("openai").refresh, "ref-rotated-1");

  // 3) PKCE S256 verifier/challenge verification in chatgptOAuth.login
  if (await isLoopbackPortFree(chatgptOAuth.CALLBACK_PORT, chatgptOAuth.CALLBACK_HOST)) {
    let notifiedUrl = null;
    let capturedForm = null;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), chatgptOAuth.TOKEN_URL);
      capturedForm = new URLSearchParams(String(init.body || ""));
      return new Response(
        JSON.stringify({
          access_token: "pkce-access-token",
          refresh_token: "pkce-refresh-token",
          expires_in: 7200,
          scope: `openid profile ${chatgptOAuth.DIRECT_TOKEN_SCOPE}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const cred = await chatgptOAuth.login({
      notify(ev) {
        if (ev.type === "auth_url") {
          const match = String(ev.message).match(/https:\/\/\S+/);
          notifiedUrl = match ? new URL(match[0]) : null;
        }
      },
      async prompt() {
        assert.ok(notifiedUrl, "auth_url notification must precede prompt resolution");
        const state = notifiedUrl.searchParams.get("state");
        return `${chatgptOAuth.REDIRECT_URI}?code=auth_code_xyz&client_id=dyn_client_42&state=${state}`;
      },
    });

    assert.equal(notifiedUrl.origin + notifiedUrl.pathname, chatgptOAuth.AUTHORIZE_URL);
    assert.equal(notifiedUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(
      notifiedUrl.searchParams.get("scope").includes(chatgptOAuth.DIRECT_TOKEN_SCOPE),
    );

    const expectedChallenge = createHash("sha256")
      .update(capturedForm.get("code_verifier"), "utf8")
      .digest("base64url");
    assert.equal(expectedChallenge, notifiedUrl.searchParams.get("code_challenge"));
    assert.equal(capturedForm.get("code"), "auth_code_xyz");
    assert.equal(capturedForm.get("client_id"), "dyn_client_42");
    assert.equal(cred.type, "oauth");
    assert.equal(cred.access, "pkce-access-token");
    assert.equal(cred.client_id, "dyn_client_42");

    // Missing direct token scope is rejected
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "no-direct-scope",
          refresh_token: "ref",
          expires_in: 3600,
          scope: "openid profile",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    let url2 = null;
    await assert.rejects(
      () =>
        chatgptOAuth.login({
          notify(ev) {
            const match = String(ev.message || "").match(/https:\/\/\S+/);
            if (match) url2 = new URL(match[0]);
          },
          async prompt() {
            return `${chatgptOAuth.REDIRECT_URI}?code=c2&client_id=cid2&state=${url2.searchParams.get("state")}`;
          },
        }),
      /no API access was granted/,
    );
  }
});

test("providers.ts & ProviderServiceImpl: built-in catalog, custom providers.json loading/validation, and model resolution", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-providers-catalog-"));
  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = tmp;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  // Built-in provider lookup & catalog structural invariants
  const allowedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);
  for (const [pid, def] of Object.entries(PROVIDERS)) {
    assert.equal(def.id, pid);
    assert.ok(def.fallback_models.length > 0, `${pid} must define fallback_models`);
    const seenIds = new Set();
    for (const model of def.fallback_models) {
      assert.equal(model.provider_id, pid);
      assert.ok(model.id.trim().length > 0);
      assert.equal(seenIds.has(model.id), false, `Duplicate model ${model.id} in ${pid}`);
      seenIds.add(model.id);
      for (const effort of model.reasoning_efforts) {
        assert.equal(allowedEfforts.has(effort), true, `Invalid effort ${effort} on ${pid}/${model.id}`);
      }
      if (model.context_window !== null) {
        assert.equal(Number.isInteger(model.context_window) && model.context_window > 0, true);
      }
      if (model.image_input !== null) {
        assert.equal(typeof model.image_input, "boolean");
      }
    }
  }
  const openaiDef = provider("openai");
  assert.equal(openaiDef.api, "openai-responses");
  assert.ok(openaiDef.auth_methods.includes("oauth"));
  assert.ok(openaiDef.fallback_models.some(m => m.id === "gpt-6.1-terra"));
  assert.ok(provider("anthropic").fallback_models.some(m => m.id === "claude-fable-5-2"));
  assert.ok(provider("google").fallback_models.some(m => m.id === "gemini-4-carbon"));
  assert.throws(() => provider("nonexistent-provider"), /Unknown provider/);

  // saveCustomProvider + custom providers.json override & model config merging
  const providersPath = path.join(tmp, "providers.json");
  saveCustomProvider("local-vllm", {
    name: "Local vLLM",
    api: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1/",
    model: "qwen-coder-32b",
    path: providersPath,
  });

  const rawJson = JSON.parse(await readFile(providersPath, "utf8"));
  rawJson.providers["local-vllm"].models["qwen-coder-32b"] = {
    contextWindow: 65536,
    imageInput: true,
    reasoningEfforts: ["low", "high"],
  };
  rawJson.providers.openai = {
    baseUrl: "https://gateway.internal.example/v1",
    models: {
      "gpt-4o-mini": {
        contextWindow: 256000,
      },
    },
  };
  await writeFile(providersPath, JSON.stringify(rawJson, null, 2), "utf8");

  const [merged, userModels] = loadProviders(providersPath);
  assert.equal(merged["local-vllm"].name, "Local vLLM");
  assert.equal(merged["local-vllm"].default_base_url, "http://127.0.0.1:8000/v1");
  assert.equal(userModels["local-vllm"]["qwen-coder-32b"].context_window, 65536);
  assert.equal(merged.openai.default_base_url, "https://gateway.internal.example/v1");

  // ProviderServiceImpl model resolution & remote refresh merging
  const credStore = new CredentialStore(path.join(tmp, "auth.json"));
  credStore.set("local-vllm", { type: "api_key", key: "local-key" });
  credStore.set("openrouter", { type: "api_key", key: "or-key" });

  const svc = new ProviderServiceImpl(credStore, PROVIDERS, async baseUrl => {
    if (baseUrl.includes("openrouter")) {
      return [
        {
          id: "meta-llama/vision-90b",
          context_length: 131072,
          architecture: { input_modalities: ["text", "image"] },
        },
      ];
    }
    return [{ id: "qwen-coder-32b" }, { id: "deepseek-r1-distill" }];
  });

  const resolvedCustom = svc.resolveSelection({
    provider_id: "local-vllm",
    model_id: "qwen-coder-32b",
    reasoning_effort: "high",
  });
  assert.equal(resolvedCustom.api, "openai-chat");
  assert.equal(resolvedCustom.context_window, 65536);
  assert.equal(resolvedCustom.image_input, true);
  assert.deepEqual(resolvedCustom.reasoning_efforts, ["low", "high"]);

  const resolvedOverriddenBuiltin = svc.resolveSelection({
    provider_id: "openai",
    model_id: "gpt-4o-mini",
    reasoning_effort: "",
  });
  assert.equal(resolvedOverriddenBuiltin.context_window, 256000);
  assert.equal(svc.describeConnection("openai", "gpt-4o-mini").kind, "overridden");
  assert.equal(svc.describeConnection("local-vllm", "qwen-coder-32b").kind, "custom");

  const catalog = await svc.listModels({ refresh: true });
  assert.equal(catalog.warning, null);
  const orVision = catalog.models.find(
    m => m.provider_id === "openrouter" && m.id === "meta-llama/vision-90b",
  );
  assert.ok(orVision);
  assert.equal(orVision.context_window, 131072);
  assert.equal(orVision.image_input, true);

  // Validation errors on malformed providers.json
  const invalidPath = path.join(tmp, "invalid-providers.json");
  await writeFile(
    invalidPath,
    JSON.stringify({ providers: { bad: { api: "not-a-protocol", baseUrl: "https://example.com" } } }),
    "utf8",
  );
  assert.throws(() => loadProviders(invalidPath), /unsupported api/);

  await writeFile(
    invalidPath,
    JSON.stringify({ providers: { bad: { api: "openai-chat", baseUrl: "ftp://example.com" } } }),
    "utf8",
  );
  assert.throws(() => loadProviders(invalidPath), /valid http\(s\) baseUrl/);

  await writeFile(
    invalidPath,
    JSON.stringify({ providers: { bad: { api: "openai-chat", baseUrl: "https://example.com", extraKey: 1 } } }),
    "utf8",
  );
  assert.throws(() => loadProviders(invalidPath), /unknown field 'extraKey'/);
});
