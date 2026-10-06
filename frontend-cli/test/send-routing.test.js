import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { connectSharedRuntime, createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
import { runSend } from "../lib/send.js";

test("rind send reaches the newest window showing a session, or runs a hosted session in the background", { timeout: 40000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-send-"));
  const folder = path.join(home, "work"); await mkdir(folder);
  const prompts = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = ""; request.on("data", value => raw += value);
    request.on("end", () => { prompts.push(raw); response.destroy(); });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" }));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const host = await startSharedServer(options);
  const delivered = { first: [], second: [] };
  const first = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", folder], onMessage() {}, onDeliver: value => delivered.first.push(value) });
  t.after(async () => { await first.shutdown(); await host.close(); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const { session_id: sessionId } = await first.request("initialize");
  const sender = () => connectSharedRuntime({ ...options, start: false });
  const send = async input => { const sendHost = await sender(); try { return await sendHost.request("runtime/send", { session_id: sessionId, input }); } finally { sendHost.close(); } };

  assert.deepEqual(await send("from a script"), { delivered: "window" });
  for (let i = 0; i < 50 && !delivered.first.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(delivered.first, [{ session_id: sessionId, input: "from a script" }]);

  // A second window showing the same session becomes the one that takes input.
  const second = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", folder, "--session", sessionId], onMessage() {}, onDeliver: value => delivered.second.push(value) });
  await second.request("initialize");
  await send("to the newest");
  for (let i = 0; i < 50 && !delivered.second.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(delivered.second.map(item => item.input), ["to the newest"]);
  assert.equal(delivered.first.length, 1);

  // With every window closed the hosted session runs the prompt by itself.
  await second.shutdown(); await first.shutdown();
  assert.deepEqual(await send("nobody is watching"), { delivered: "started" });
  for (let i = 0; i < 200 && !prompts.some(body => body.includes("nobody is watching")); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(prompts.some(body => body.includes("nobody is watching")), "the background turn reached the model");

  const missing = await sender();
  await assert.rejects(missing.request("runtime/send", { session_id: "20260101_never", input: "hi" }), { code: "SESSION_NOT_OPEN" });
  missing.close();
});

test("rind send reports how it was delivered and falls back to a private window's endpoint", async () => {
  const out = [], err = [];
  const io = { stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } };
  const host = result => async () => ({ request: async () => result(), close() {} });
  assert.equal(await runSend({ args: ["send", "--session", "abc", "hi"], ...io, connect: host(() => ({ delivered: "started" })) }), 0);
  assert.match(out.at(-1), /started in the background · session abc/);
  const refused = () => { throw Object.assign(new Error("No Rind window has session abc open."), { code: "SESSION_NOT_OPEN" }); };
  assert.equal(await runSend({ args: ["send", "--session", "abc", "hi"], ...io, connect: host(refused) }), 1, "no window and no private endpoint");
  assert.match(err.at(-1), /abc/);
  const broken = () => { throw Object.assign(new Error("A session and a non-empty prompt are required."), { code: "INVALID_INPUT" }); };
  assert.equal(await runSend({ args: ["send", "--session", "abc", "hi"], ...io, connect: host(broken) }), 1);
  assert.match(err.at(-1), /non-empty prompt/, "other host errors are reported as they are");
});
