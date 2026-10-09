import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "../dist/ipc.js";
import { connectClient } from "../dist/client.js";
import { connectSharedRuntime, createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
async function stopRuntime(home) {
  const client = await connectSharedRuntime({ home, start: false }).catch(() => null);
  if (!client) return;
  await client.request("runtime/shutdown").catch(() => {}); client.close();
  await new Promise(resolve => setTimeout(resolve, 300));
}
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
test("direct session remains observable after detach and management restart, and reopens without a duplicate run", { timeout: 25000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-session-observe-"));
  const workspace = path.join(home, "member"); await mkdir(workspace);
  let response, resolveResponse, calls = 0;
  const responseArrived = new Promise(resolve => { resolveResponse = resolve; });
  const provider = http.createServer((request, res) => {
    if (request.method === "GET") { res.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    request.resume(); request.on("end", () => { calls++; response = res; resolveResponse(); });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", apiKey: "fixture", model: "fixture", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" }));
  const options = { home, repoRoot, python: process.env.RIND_PYTHON || "python" };
  let server = await startServer(options);
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const connect = () => connectClient({ endpoint: server.paths.endpoint, token });
  let user = await connect(), viewer;
  const agent = await user.request("registerAgent", { workspace });
  const team = await user.request("createTeam", { name: "Product" });
  await user.request("addMember", { teamId: team.id, agentId: agent.id });
  const session = await user.request("attachSession", { agentId: agent.id, teamId: team.id, shared: true });
  const config = await user.request("sessionTools", { sessionId: session.id });
  const first = createSharedRuntimeClient({ ...options, rindHome: home, cliArgs: ["--cwd", workspace], externalTools: config });
  t.after(async () => { response?.end(); await first.shutdown(); await viewer?.shutdown(); user.close(); await server.close(); await stopRuntime(home); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.equal((await first.request("initialize")).session_id, "", "a window has no conversation before its first message");
  const info = await first.request("session/create", {});
  await user.request("bindSession", { sessionId: session.id, runtimeSessionId: info.session_id });
  const pending = first.request("session/prompt", { session_id: info.session_id, input: "Work in background" }).catch(error => error);
  await Promise.race([
    responseArrived,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("fixture provider did not receive the request")), 10000); timer.unref?.(); })
  ]);
  assert.ok(response);
  await first.shutdown(); await pending;
  await user.request("detachSession", { sessionId: session.id });
  assert.equal((await user.request("snapshot")).sessions.find(s => s.id === session.id).status, "Working");
  user.close(); await server.close(); server = await startServer(options); user = await connect();
  for (let i = 0; i < 200; i++) { if ((await user.request("snapshot")).sessions.find(s => s.id === session.id).status === "Working") break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal((await user.request("snapshot")).sessions.find(s => s.id === session.id).status, "Working");
  const attached = await user.request("attachSession", { agentId: agent.id, teamId: team.id, runtimeSessionId: info.session_id, shared: true });
  assert.equal(attached.id, session.id);
  viewer = createSharedRuntimeClient({ ...options, rindHome: home, cliArgs: ["--cwd", workspace, "--session", info.session_id], externalTools: await user.request("sessionTools", { sessionId: session.id }) });
  assert.equal((await viewer.request("initialize")).live_turn.status, "running");
  await assert.rejects(viewer.request("session/prompt", { session_id: info.session_id, input: "Duplicate" }), /active request/);
  const history = await user.request("listSessions", { agentId: agent.id });
  assert.ok(history.sessions.some(s => s.runtimeSessionId === info.session_id && s.teamId === team.id));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end('data: {"choices":[{"index":0,"delta":{"content":"Recovered delivery"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  for (let i = 0; i < 200; i++) { if ((await user.request("snapshot")).runs[0].status === "succeeded") break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const snapshot = await user.request("snapshot");
  assert.equal(snapshot.runs.length, 1); assert.equal(snapshot.runs[0].status, "succeeded"); assert.equal(calls, 1);
  assert.match(JSON.stringify(await viewer.request("session/replay", { session_id: info.session_id })), /Recovered delivery/);
});
test("direct CLI captures activity, rejects ambiguous teams, and manager exposes only management tools", { timeout: 40000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-direct-e2e-"));
  const workspace = path.join(home, "finance");
  await mkdir(workspace);
  const requests = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = "";
    request.on("data", chunk => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw); requests.push(body);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "Observed direct reply." }, finish_reason: null }] }) + "\n\n");
      response.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1", apiKey: "fixture", model: "fixture" }));
  const server = await startServer({ home, repoRoot, python: process.env.RIND_PYTHON || "python" });
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  t.after(async () => { client.close(); await server.close(); await stopRuntime(home); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const agent = await client.request("registerAgent", { workspace });
  const team = await client.request("createTeam", { name: "Company A" });
  await client.request("addMember", { teamId: team.id, agentId: agent.id });
  async function cli(args, input = "") {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repoRoot, "frontend-cli/bin/rind.js"), ...args], { cwd: workspace, env: { ...process.env, RIND_HOME: home, RIND_RUNTIME_PATH: "" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
    });
  }
  const direct = await cli(["run", "--dir", workspace, "--prompt", "Say hello"]);
  assert.equal(direct.code, 0, direct.stderr);
  let view = await client.request("snapshot");
  assert.ok(view.sessions.some(s => s.agentId === agent.id && s.teamId === team.id && s.runtimeSessionId));
  assert.equal(view.runs.at(-1).status, "succeeded");
  const other = await client.request("createTeam", { name: "Company B" });
  await client.request("addMember", { teamId: other.id, agentId: agent.id, share: true });
  const ambiguous = await cli(["run", "--dir", workspace, "--prompt", "Say hello"]);
  assert.notEqual(ambiguous.code, 0); assert.match(ambiguous.stderr, /--team.*--standalone/);
  const independent = await cli(["run", "--dir", workspace, "--standalone", "--prompt", "Say hello"]);
  assert.equal(independent.code, 0, independent.stderr);
  // Resume-latest must keep the independent scope even when the workspace belongs to several teams.
  const resumed = await cli(["--resume-latest"], "Say hello again\n");
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal((await client.request("snapshot")).sessions.length, 2);
  await stopRuntime(home);
  const reopened = await cli(["--resume-latest"], "After host restart\n");
  assert.equal(reopened.code, 0, reopened.stderr);
  assert.equal((await client.request("snapshot")).runs.at(-1).status, "succeeded");
  const manager = await cli(["--manager"], "Say hello\n");
  assert.equal(manager.code, 0, manager.stderr);
  assert.deepEqual(requests.at(-1).tools.map(t => t.function.name), ["agent_management"], manager.stdout + "\n" + manager.stderr);
  view = await client.request("snapshot");
  assert.equal(view.runs.at(-1).status, "succeeded");
});

test("real Rind reports through the declared tool and the task is delivered", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-managed-e2e-"));
  const workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  let taskId, calls = 0, release, arrived;
  const joined = new Promise(resolve => { release = resolve; });
  const firstRequest = new Promise(resolve => { arrived = resolve; });
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = ""; request.on("data", chunk => raw += chunk); request.on("end", async () => {
      if (calls === 0) { arrived(); await joined; }
      const body = JSON.parse(raw);
      const names = body.tools.map(t => t.function.name);
      assert.ok(names.includes("report") && names.includes("delegate"), "a leader's task run delivers and delegates");
      assert.ok(!names.includes("agent_management") && !names.includes("ask_user_question"), "a task run neither manages nor asks the user");
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const delta = calls++ === 0 ? { tool_calls: [{ index: 0, id: "report-1", type: "function", function: { name: "report", arguments: JSON.stringify({ outcome: "completed", summary: "Fixture delivery", evidence: ["Local provider verified tool roundtrip"] }) } }] } : { content: "Delivery complete." };
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n");
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }) + "\n\n");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1", apiKey: "fixture-key", model: "fixture" }));
  const server = await startServer({ home, repoRoot, python: process.env.RIND_PYTHON || "python" });
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const client = await connectClient({ endpoint: server.paths.endpoint, token });
  t.after(async () => { client.close(); await server.close(); await stopRuntime(home); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const team = await client.request("createTeam", { name: "E2E" });
  const agent = await client.request("registerAgent", { workspace });
  await client.request("addMember", { teamId: team.id, agentId: agent.id });
  await client.request("setLeader", { teamId: team.id, agentId: agent.id });
  const task = await client.request("assignTask", { teamId: team.id, assigneeAgentId: agent.id, brief: "Submit the fixture report.", start: false });
  taskId = task.id;
  await client.request("startTask", { taskId });
  // A window joins the task's conversation while it runs: it opens the same session, configured the same way.
  await firstRequest;
  const view = await client.request("snapshot");
  const managed = view.sessions.find(s => s.origin === "managed");
  const { runtimeSessionId } = managed;
  const window = createSharedRuntimeClient({ home, rindHome: home, repoRoot, python: process.env.RIND_PYTHON || "python", cliArgs: ["--cwd", workspace, "--session", runtimeSessionId], externalTools: await client.request("sessionTools", { sessionId: managed.id }) });
  try { assert.equal((await window.request("initialize")).session_id, runtimeSessionId); }
  finally { await window.shutdown(); release(); }
  let current;
  for (let i = 0; i < 100; i++) {
    current = await client.request("getTask", { taskId });
    if (["done", "needs_attention"].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(current.status, "done", JSON.stringify(current));
  assert.equal(current.report.summary, "Fixture delivery");
  assert.equal(calls, 2);
});
