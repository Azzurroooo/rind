import test from "node:test";
import assert from "node:assert/strict";
import { fetchModelResponse, modelRetryDelay, parseSseJsonEvents, throwForHttpError } from "../dist/infrastructure/llm/sse.js";
import { OpenAIChatCompletionsClient } from "../dist/infrastructure/llm/openai-chat.js";
import { CancellationTokenSource } from "../dist/domain/cancellation.js";

test("model request times out headers, aborts I/O, and cancels a late response", async t => {
  let signal, resolve, cancelled = false;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    signal = options.signal;
    return new Promise(r => { resolve = r; });
  });
  await assert.rejects(fetchModelResponse("http://fake.invalid", {}, null, 10), /timed out/);
  assert.equal(signal.aborted, true);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(r => setImmediate(r));
  assert.equal(cancelled, true);
});

test("SSE early return, DONE and JSON parse failures dispose their request", async t => {
  for (const data of ['data: {"ok":true}\n\n', 'data: [DONE]\n\n', 'data: broken\n\n']) {
    let cancelled = false, signal;
    const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(data)); },
        cancel() { cancelled = true; },
      }));
    });
    const response = await fetchModelResponse("http://fake.invalid", {});
    const run = async () => { for await (const event of parseSseJsonEvents(response)) break; };
    if (data.includes("broken")) await assert.rejects(run, SyntaxError); else await run();
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);
    assert.equal(response.body.locked, false);
    mock.mock.restore();
  }
});

test("body inactivity and explicit cancellation terminate both JSON and error reads", async t => {
  for (const status of [200, 400]) {
    let signal, cancelled = false;
    const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    });
    const response = await fetchModelResponse("http://fake.invalid", {}, null, 10);
    await assert.rejects(status === 200 ? response.json() : throwForHttpError(response), /timed out/);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    const source = new CancellationTokenSource();
    const next = await fetchModelResponse("http://fake.invalid", {}, source.token);
    const read = next.json();
    source.cancel("stop");
    await assert.rejects(read, /stop|cancel/i);
    assert.equal(signal.aborted, true);
    mock.mock.restore();
  }
});

test("HTTP error bodies are bounded and retry responses are cancelled", async t => {
  let cancelled = false;
  const large = new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(100_000))); },
    cancel() { cancelled = true; },
  }), { status: 400 });
  await assert.rejects(throwForHttpError(large), e => e.status_code === 400 && e.message.length <= 65536);
  assert.equal(cancelled, true);
  let calls = 0;
  cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 429, headers: { "retry-after": "0" },
    });
    assert.equal(cancelled, true);
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  });
  await new OpenAIChatCompletionsClient({ model: "fake", apiKey: "fake" }).create([]);
  assert.equal(calls, 2);
  assert.equal(modelRetryDelay(0, new Headers({ "retry-after": "10" })), 10000);
  assert.equal(modelRetryDelay(0, new Headers({ "retry-after": "999999" })), 60000);
  assert.equal(modelRetryDelay(0, new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" }), 0), 10000);
});

test("unrelated 4xx errors never disable reasoning or trigger capability retries", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ error: { message: "Invalid API key: request blocked" } }, { status: 401 });
  });
  const client = new OpenAIChatCompletionsClient({ model: "fake", apiKey: "fake", reasoningEffort: "high", reasoningEfforts: ["high"] });
  for (let i = 0; i < 2; i++) await assert.rejects(client.create([]), /Invalid API key/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.reasoning_effort === "high"));
});
