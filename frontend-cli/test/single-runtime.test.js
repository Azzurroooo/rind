// Every entry point must end up on one Runtime host and one worker. These
// tests start real processes against a temporary RIND_HOME and compare the
// pids every client reports.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { removeRindHome } from "./helpers/rind-home.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));
const runtimeModule = new URL("../../rind-runtime-client/shared-runtime.js", import.meta.url).href;
const runtimeOptions = home => ({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot });

function runCli(home, cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rindBin, ...args], { cwd, env: { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

async function stopServices(home) {
  await new Promise(resolve => {
    const child = spawn(process.execPath, [rindBin, "agents", "stop", "--all"], { cwd: home, env: { ...process.env, RIND_HOME: home, NO_COLOR: "1" }, windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

// A fake OpenAI-compatible endpoint that streams one short answer.
async function fixtureProvider() {
  const responses = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    request.resume();
    request.on("end", () => {
      responses.push(response);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"choices":[{"index":0,"delta":{"content":"Finished"},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  return { provider, url: "http://127.0.0.1:" + provider.address().port + "/v1" };
}

test("concurrent starts converge on one host and one worker", { timeout: 120000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-one-host-"));
  t.after(() => removeRindHome(home));
  const script = `
    const { connectSharedRuntime } = await import(${JSON.stringify(runtimeModule)});
    const host = await connectSharedRuntime(${JSON.stringify(runtimeOptions(home))});
    const info = await host.request("runtime/info");
    const worker = await host.request("runtime/observe");
    console.log(JSON.stringify({ host: info.pid, worker: worker.pid }));
    host.close();
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => runNode(script)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const seen = results.map(result => JSON.parse(result.stdout.trim()));
  assert.equal(new Set(seen.map(item => item.host)).size, 1, "one Runtime host");
  assert.equal(new Set(seen.map(item => item.worker)).size, 1, "one worker");
  const host = await connectSharedRuntime({ ...runtimeOptions(home), start: false });
  assert.equal((await host.request("runtime/info")).pid, seen[0].host, "the surviving host is the one everyone saw");
  host.close();
});

test("a stale host lock never blocks a start", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-stale-lock-"));
  t.after(() => removeRindHome(home));
  await mkdir(path.join(home, "runtime"), { recursive: true });
  await writeFile(path.join(home, "runtime", "host.lock"), JSON.stringify({ pid: 99999999, at: 0, nonce: "stale" }));
  const host = await connectSharedRuntime(runtimeOptions(home));
  assert.ok((await host.request("runtime/info")).pid > 0);
  host.close();
});

test("a second server refuses an endpoint a live host owns", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-endpoint-owned-"));
  t.after(() => removeRindHome(home));
  const host = await startSharedServer(runtimeOptions(home));
  t.after(() => host.close());
  await assert.rejects(startSharedServer(runtimeOptions(home)), /already running/i);
});

test("rind run shares the one Runtime and reuses its worker", { timeout: 180000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-run-shared-"));
  const workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const fixture = await fixtureProvider();
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: fixture.url }));
  t.after(async () => { await stopServices(home); await removeRindHome(home); await new Promise(resolve => fixture.provider.close(resolve)); });

  const first = await runCli(home, workspace, "run", "--prompt", "hello", "--dir", workspace);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Finished/);
  const host = await connectSharedRuntime({ ...runtimeOptions(home), start: false });
  t.after(() => host.close());
  const hostPid = (await host.request("runtime/info")).pid;
  const workerPid = (await host.request("runtime/observe")).pid;

  const second = await runCli(home, workspace, "run", "--prompt", "again", "--dir", workspace);
  assert.equal(second.code, 0, second.stderr);
  assert.equal((await host.request("runtime/info")).pid, hostPid, "the same host served the second run");
  assert.equal((await host.request("runtime/observe")).pid, workerPid, "the same worker served the second run");
});

test("rind send never starts a Runtime", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-send-cold-"));
  t.after(() => removeRindHome(home));
  const sent = await runCli(home, home, "send", "--session", "missing", "hello");
  assert.notEqual(sent.code, 0, "an unopened session is refused");
  await assert.rejects(connectSharedRuntime({ ...runtimeOptions(home), start: false }), "no host was started");
});

test("the management service reports one Runtime pid across connections", { timeout: 120000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-service-pid-"));
  const workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(async () => { await stopServices(home); await removeRindHome(home); });
  const listed = await runCli(home, workspace, "agents", "list", "--json");
  assert.equal(listed.code, 0, listed.stderr);

  const host = await connectSharedRuntime(runtimeOptions(home));
  const hostInfo = await host.request("runtime/info");
  const { connectManagement } = await import("../../agent-management/dist/client.js");
  const management = await connectManagement({ home, python: process.env.RIND_PYTHON || "python", repoRoot, start: false });
  t.after(() => { management.close(); host.close(); });
  await management.request("listSessions", { independent: true });
  const info = await management.request("serviceInfo");
  assert.ok(info.runtime, "the service is attached to the shared Runtime");
  assert.equal(info.runtime.pid, hostInfo.pid, "management reports the live Runtime pid");
  assert.equal(info.runtime.startedAt, hostInfo.startedAt);
  const second = await connectManagement({ home, python: process.env.RIND_PYTHON || "python", repoRoot, start: false });
  t.after(() => second.close());
  assert.equal((await second.request("serviceInfo")).pid, info.pid, "one management service");
});
