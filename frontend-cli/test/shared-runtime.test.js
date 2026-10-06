import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { connectSharedRuntime, createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";

test("one host isolates workspaces and tools, runs sessions concurrently and survives client detach", { timeout: 25000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-shared-test-"));
  const a = path.join(home, "a"), b = path.join(home, "b");
  await mkdir(a); await mkdir(b);
  const responses = [], requests = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = ""; request.on("data", value => raw += value); request.on("end", () => {
      requests.push(JSON.parse(raw)); responses.push(response);
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" }));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const host = await startSharedServer(options);
  const eventsA = [], eventsB = [];
  const tool = { command: process.execPath, args: [], env: {}, name: "restricted", description: "Fixture", enabled_tools: ["restricted"] };
  const first = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", a], externalTools: tool, onMessage: event => eventsA.push(event) });
  const second = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", b], onMessage: event => eventsB.push(event) });
  const admin = await connectSharedRuntime({ ...options, start: false });
  t.after(async () => { await first.shutdown(); await second.shutdown(); admin.close(); responses.forEach(r => r.end()); await host.close(); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const infoA = await first.request("initialize"), infoB = await second.request("initialize");
  assert.notEqual(infoA.session_id, infoB.session_id);
  assert.equal(path.resolve(infoA.workspace_root).toLowerCase(), a.toLowerCase());
  assert.equal(path.resolve(infoB.workspace_root).toLowerCase(), b.toLowerCase());
  const pidA = await first.request("runtime/observe"), pidB = await second.request("runtime/observe");
  assert.equal(pidA.pid, pidB.pid);
  // These conversations have no message yet; one held by no connection is
  // forgotten, so the admin connection holds them while the windows reconnect.
  await admin.request("session/subscribe", { session_id: infoA.session_id });
  await admin.request("session/subscribe", { session_id: infoB.session_id });
  // Use separate ordinary connections to test event filtering, without observe-all.
  await first.shutdown(); await second.shutdown();
  const one = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", a, "--session", infoA.session_id], externalTools: tool, onMessage: e => eventsA.push(e) });
  const two = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", b, "--session", infoB.session_id], onMessage: e => eventsB.push(e) });
  t.after(async () => { await one.shutdown(); await two.shutdown(); });
  await one.request("initialize"); await two.request("initialize");
  const turnA = one.request("session/prompt", { session_id: infoA.session_id, input: "A" }).catch(error => error);
  const turnB = two.request("session/prompt", { session_id: infoB.session_id, input: "B" });
  for (let i = 0; requests.length < 2 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 20));
  // Joining live execution may adjust presentation instructions, but cannot change its tool authority.
  const joined = await admin.request("session/open", { workspace_root: a, session_id: infoA.session_id, external_tools: { ...tool, instructions: "Updated role wording" } });
  assert.equal(joined.session_id, infoA.session_id);
  await assert.rejects(admin.request("session/open", { workspace_root: a, session_id: infoA.session_id }), /running session/);
  assert.equal(requests.length, 2, "both model requests must be in flight at once");
  const restricted = requests.find(r => r.messages.some(m => m.role === "user" && m.content === "A"));
  assert.deepEqual(restricted.tools.map(t => t.function.name), ["restricted"]);
  assert.ok(requests.find(r => r !== restricted).tools.some(t => t.function.name === "bash"));
  await one.shutdown(); assert.equal((await turnA).code, "EXECUTION_UNCONFIRMED");
  for (const response of responses) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"Finished"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }
  await turnB;
  for (let i = 0; i < 100; i++) {
    const replay = await admin.request("session/replay", { session_id: infoA.session_id });
    if (!replay.live_turn && JSON.stringify(replay).includes("Finished")) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const resumed = await admin.request("session/open", { workspace_root: a, session_id: infoA.session_id, external_tools: tool });
  assert.equal(resumed.session_id, infoA.session_id);
  assert.match(JSON.stringify(await admin.request("session/replay", { session_id: infoA.session_id })), /Finished/);
  assert.ok(eventsB.every(event => event.session_id === infoB.session_id));
  await assert.rejects(admin.request("session/open", { workspace_root: b, session_id: infoA.session_id }), /workspace/i);
});
