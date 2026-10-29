import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { RuntimeWorker, RuntimeDispatcher } from "../dist/index.js";

test("RuntimeDispatcher and RuntimeWorker handle full session lifecycle, slash commands, folder defaults, and prompt streaming", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-server-proto-"));
  const rindHome = path.join(tmp, "home");
  const workspace = path.join(tmp, "workspace");
  await mkdir(rindHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const previousHome = process.env.RIND_HOME;
  process.env.RIND_HOME = rindHome;

  const provider = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture-fast" }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Protocol OK."},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":4,"total_tokens":19}}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;

  await writeFile(path.join(rindHome, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture-fast" }));
  await writeFile(path.join(rindHome, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "test-key" } }));
  await writeFile(
    path.join(rindHome, "providers.json"),
    JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl } } }),
  );

  const worker = new RuntimeWorker({ workspaceRoot: workspace });
  const sent = [];
  const writer = {
    async send(msg) {
      sent.push(msg);
    },
  };
  const dispatcher = new RuntimeDispatcher(worker, {
    writer,
    allowSessionConfiguration: true,
  });

  t.after(async () => {
    dispatcher.close();
    await worker.close();
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
    if (previousHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = previousHome;
    await rm(tmp, { recursive: true, force: true });
  });

  async function rpc(requestId, method, params = {}) {
    await dispatcher.dispatch({ kind: "request", request_id: requestId, method, params });
    const response = sent.find(m => m.kind === "response" && m.request_id === requestId);
    assert.ok(response, `Expected response for ${requestId} (${method})`);
    return response;
  }

  const initRes = await rpc("1", "initialize");
  assert.equal(initRes.result.protocol_version, "2");
  assert.equal(initRes.result.session_id, "");

  const createRes = await rpc("2", "session/create", { workspace_root: workspace });
  const sessionId = createRes.result.session_id;
  assert.ok(sessionId);

  const promptRes = await rpc("3", "session/prompt", {
    session_id: sessionId,
    input: "Test prompt",
  });
  assert.equal(promptRes.error, undefined);
  assert.equal(promptRes.result.ok, true);
  assert.equal(promptRes.result.session_id, sessionId);
  assert.ok(promptRes.result.turn_id);
  assert.ok(
    sent.some(
      m =>
        m.kind === "event" &&
        m.event?.type === "assistant_message_completed" &&
        m.event?.content === "Protocol OK.",
    ),
  );

  const statusCmd = await rpc("4", "rind/command/execute", {
    session_id: sessionId,
    input: "/status",
  });
  assert.equal(statusCmd.result.display?.type, "status");
  assert.equal(statusCmd.result.display?.selection?.model, "fixture-fast");

  const replayRes = await rpc("5", "session/replay", { session_id: sessionId });
  assert.equal(replayRes.result.messages.length, 3);
});

test("RuntimeDispatcher cancels active model stream and running bash tool immediately on session/cancel", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-server-cancel-"));
  const rindHome = path.join(tmp, "home");
  const workspace = path.join(tmp, "workspace");
  await mkdir(rindHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const previousHome = process.env.RIND_HOME;
  process.env.RIND_HOME = rindHome;

  let streamMode = "slow_text";
  let postRequestCount = 0;
  let notifyStreamStarted = null;

  const provider = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture-fast" }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      postRequestCount += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (streamMode === "slow_text") {
        res.write('data: {"choices":[{"index":0,"delta":{"content":"Starting slow stream..."},"finish_reason":null}]}\n\n');
        notifyStreamStarted?.();
        // Keep connection open until client aborts
        return;
      }
      if (streamMode === "bash_sleep") {
        res.write(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_sleep","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"sleep 30\\"}"}}]},"finish_reason":null}]}\n\n',
        );
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":15,"completion_tokens":8,"total_tokens":23}}\n\n');
        res.end("data: [DONE]\n\n");
        return;
      }
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;

  await writeFile(path.join(rindHome, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture-fast" }));
  await writeFile(path.join(rindHome, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "test-key" } }));
  await writeFile(
    path.join(rindHome, "providers.json"),
    JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl } } }),
  );

  const worker = new RuntimeWorker({ workspaceRoot: workspace });
  const sent = [];
  const writer = {
    async send(msg) {
      sent.push(msg);
    },
  };
  const dispatcher = new RuntimeDispatcher(worker, {
    writer,
    allowSessionConfiguration: true,
  });

  t.after(async () => {
    dispatcher.close();
    await worker.close();
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
    if (previousHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = previousHome;
    await rm(tmp, { recursive: true, force: true });
  });

  await dispatcher.dispatch({ kind: "request", request_id: "init", method: "initialize", params: {} });
  await dispatcher.dispatch({
    kind: "request",
    request_id: "create",
    method: "session/create",
    params: { workspace_root: workspace },
  });
  const sessionId = sent.find(m => m.kind === "response" && m.request_id === "create").result.session_id;

  // 1. Cancel while model SSE stream is hanging
  const streamStarted = new Promise(resolve => {
    notifyStreamStarted = resolve;
  });
  const prompt1Promise = dispatcher.dispatch({
    kind: "request",
    request_id: "prompt-1",
    method: "session/prompt",
    params: { session_id: sessionId, input: "Stream something slow" },
  });
  await streamStarted;
  await new Promise(resolve => setTimeout(resolve, 20));

  const cancelStart1 = Date.now();
  await dispatcher.dispatch({
    kind: "request",
    request_id: "cancel-1",
    method: "session/cancel",
    params: { session_id: sessionId },
  });
  await prompt1Promise;
  const elapsed1 = Date.now() - cancelStart1;

  assert.ok(elapsed1 < 500, `Expected SSE stream cancellation < 500ms, got ${elapsed1}ms`);
  assert.equal(postRequestCount, 1, "Must not retry cancelled stream as stream_interrupted");
  assert.ok(sent.some(m => m.kind === "event" && m.event?.type === "turn_cancelled"));
  assert.equal(
    sent.some(m => m.kind === "event" && m.event?.type === "turn_step_retry"),
    false,
  );

  // 2. Cancel while foreground bash tool ("sleep 30") is running
  sent.length = 0;
  streamMode = "bash_sleep";
  const prompt2Promise = dispatcher.dispatch({
    kind: "request",
    request_id: "prompt-2",
    method: "session/prompt",
    params: { session_id: sessionId, input: "Run sleep 30" },
  });
  while (!sent.some(m => m.kind === "event" && m.event?.type === "tool_call_started" && m.event?.tool_name === "bash")) {
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await new Promise(resolve => setTimeout(resolve, 30));

  const cancelStart2 = Date.now();
  await dispatcher.dispatch({
    kind: "request",
    request_id: "cancel-2",
    method: "session/cancel",
    params: { session_id: sessionId },
  });
  await prompt2Promise;
  const elapsed2 = Date.now() - cancelStart2;

  assert.ok(elapsed2 < 500, `Expected bash tool cancellation < 500ms, got ${elapsed2}ms`);
  assert.ok(sent.some(m => m.kind === "event" && m.event?.type === "turn_cancelled"));
});
