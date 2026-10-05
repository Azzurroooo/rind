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
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
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
  t.after(async () => { client.close(); await server.close(); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true }); });
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
  const manager = await cli(["--manager"], "Say hello\n");
  assert.equal(manager.code, 0, manager.stderr);
  assert.deepEqual(requests.at(-1).tools.map(t => t.function.name), ["agent_management"]);
  view = await client.request("snapshot");
  assert.equal(view.runs.at(-1).status, "succeeded");
});

test("real Rind executes the scoped external tool and returns a durable report", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-managed-e2e-"));
  const workspace = path.join(home, "workspace");
  await mkdir(path.join(workspace, ".rind"), { recursive: true });
  let taskId, calls = 0;
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = ""; request.on("data", chunk => raw += chunk); request.on("end", () => {
      const body = JSON.parse(raw);
      assert.ok(body.tools.some(t => t.function.name === "agent_management"));
      assert.ok(!body.tools.some(t => t.function.name === "delegate"));
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const delta = calls++ === 0 ? { tool_calls: [{ index: 0, id: "report-1", type: "function", function: { name: "agent_management", arguments: JSON.stringify({ action: "updateTask", parameters: { taskId, report: { outcome: "completed", summary: "Fixture delivery", evidence: ["Local provider verified tool roundtrip"], artifacts: [] } } }) } }] } : { content: "Delivery complete." };
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n");
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }) + "\n\n");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(workspace, ".rind", "settings.json"), JSON.stringify({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1", apiKey: "fixture-key", model: "fixture" }));
  const server = await startServer({ home, repoRoot, python: process.env.RIND_PYTHON || "python" });
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const client = await connectClient({ endpoint: server.paths.endpoint, token });
  t.after(async () => { client.close(); await server.close(); await new Promise(resolve => provider.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const team = await client.request("createTeam", { name: "E2E" });
  const agent = await client.request("registerAgent", { workspace });
  await client.request("addMember", { teamId: team.id, agentId: agent.id });
  await client.request("setLeader", { teamId: team.id, agentId: agent.id });
  const task = await client.request("assignTask", { teamId: team.id, assigneeAgentId: agent.id, brief: "Submit the fixture report.", start: false });
  taskId = task.id;
  await client.request("startTask", { taskId });
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
