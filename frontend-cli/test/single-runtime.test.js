// Every entry point must end up on one Runtime host and one worker. These
// tests start real processes against a temporary RIND_HOME and compare the
// pids every client reports.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectSharedRuntime, sharedRuntimePaths } from "../../rind-runtime-client/shared-runtime.js";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { probeEndpoint } from "../../rind-runtime-client/endpoint.js";
import { removeRindHome } from "./helpers/rind-home.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));
const runtimeModule = new URL("../../rind-runtime-client/shared-runtime.js", import.meta.url).href;
const runtimeOptions = home => ({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: fixture.url } } }));
  t.after(async () => { await stopServices(home); await removeRindHome(home); await new Promise(resolve => fixture.provider.close(resolve)); });

  const host = await connectSharedRuntime(runtimeOptions(home));
  t.after(() => host.close());
  const hostPid = (await host.request("runtime/info")).pid;
  const workerPid = (await host.request("runtime/observe")).pid;
  const first = await runCli(home, workspace, "run", "--prompt", "hello", "--dir", workspace);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Finished/);

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

test("session/replay tail windows a long conversation and reports the total", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-replay-window-"));
  const workspace = path.join(home, "workspace");
  const sessionDir = path.join(home, "sessions", "20260101_long");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // The store compares its normalized workspace root, as a saved session would hold.
  const canonical = await realpath(workspace);
  const workspaceRoot = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const messages = Array.from({ length: 10 }, (_, index) => JSON.stringify({
    id: "m" + index, role: index % 2 ? "assistant" : "user", content: "message " + index,
    ts: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  await writeFile(path.join(sessionDir, "messages.jsonl"), messages.join("\n") + "\n");
  await writeFile(path.join(sessionDir, "tool_calls.jsonl"), "");
  await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify({ schema_version: "2.0", session_id: "20260101_long", workspace_root: workspaceRoot, model: "fixture" }));
  await writeFile(path.join(home, "session_index.json"), JSON.stringify({ sessions: [
    { id: "20260101_long", workspace_root: workspaceRoot, updated_at: "2026-01-02T00:00:00Z", has_user_message: true },
  ] }));
  t.after(() => removeRindHome(home));

  const host = await connectSharedRuntime(runtimeOptions(home));
  t.after(() => host.close());
  await host.request("initialize");
  const replay = await host.request("session/replay", { session_id: "20260101_long", tail: 3 });

  assert.equal(replay.message_total, 10);
  assert.deepEqual(replay.messages.map(message => message.content), ["message 7", "message 8", "message 9"]);
  const full = await host.request("session/replay", { session_id: "20260101_long" });
  assert.equal(full.messages.length, 10, "an unbounded replay is unchanged");
  const range = await host.request("session/replay", { session_id: "20260101_long", start: 4, end: 7 });
  assert.equal(range.message_total, 10, "range replay reports the full conversation length");
  assert.deepEqual(range.messages.map(message => message.content), ["message 4", "message 5", "message 6"]);
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

test("a Runtime whose worker died still exits, and the next window starts a fresh one", { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-dead-worker-"));
  t.after(() => removeRindHome(home));
  const host = await connectSharedRuntime(runtimeOptions(home));
  await host.request("initialize");
  const info = await host.request("runtime/info");
  const worker = await host.request("runtime/observe");
  assert.ok(info.pid > 0 && worker.pid > 0);

  // The worker dies under the host, and a shutdown request races the death.
  process.kill(worker.pid);
  await host.request("runtime/shutdown").catch(() => {});
  host.close();
  for (let i = 0; i < 200 && alive(info.pid); i++) await sleep(50);
  assert.equal(alive(info.pid), false, "the host exits instead of lingering as a zombie");
  for (let i = 0; i < 40 && await probeEndpoint(sharedRuntimePaths(home).endpoint); i++) await sleep(50);
  assert.equal(await probeEndpoint(sharedRuntimePaths(home).endpoint), false, "the endpoint is free again");

  const again = await connectSharedRuntime(runtimeOptions(home));
  t.after(() => again.close());
  const fresh = await again.request("runtime/info");
  assert.notEqual(fresh.pid, info.pid, "a fresh host serves the next window");
  await again.request("runtime/shutdown").catch(() => {});
});

test("a pid record cannot authorize killing an unrelated endpoint owner", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-stuck-host-"));
  const paths = sharedRuntimePaths(home);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.token, "test-token", { mode: 0o600 });
  // A squatter owns the endpoint: it accepts connections and never answers.
  const squatter = spawn(process.execPath, ["-e", "const net = require('node:net'); const server = net.createServer(() => {}); server.listen(process.argv[1]); setInterval(() => {}, 1000);", paths.endpoint], { stdio: "ignore", windowsHide: true });
  t.after(async () => {
    if (squatter.exitCode === null) {
      const stopped = new Promise(resolve => squatter.once("exit", resolve));
      squatter.kill("SIGKILL"); await stopped;
    }
    await removeRindHome(home);
  });
  for (let i = 0; i < 100 && !(await probeEndpoint(paths.endpoint)); i++) await sleep(50);
  assert.equal(await probeEndpoint(paths.endpoint), true, "the squatter holds the endpoint");
  await writeFile(paths.record, JSON.stringify({ pid: squatter.pid, nonce: "4a33659c-f104-4f13-8c19-910c4e57c167", startedAt: new Date().toISOString() }), { mode: 0o600 });

  await assert.rejects(connectSharedRuntime(runtimeOptions(home)), /without answering/);
  assert.equal(alive(squatter.pid), true, "a stale pid record never kills unrelated user work");
  await writeFile(paths.record, "{broken");
  await assert.rejects(connectSharedRuntime(runtimeOptions(home)), /without answering/, "corrupt records do not authorize recovery");
  assert.equal(alive(squatter.pid), true);
});

test("a verified shared host that stopped answering can be replaced", { timeout: 45000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-verified-stuck-"));
  const paths = sharedRuntimePaths(home);
  await mkdir(paths.directory, { recursive: true });
  const preload = path.join(home, "stuck.mjs");
  await writeFile(preload, "import net from 'node:net'; const write = net.Socket.prototype.write; net.Socket.prototype.write = function (...args) { return this === process.stdout || this === process.stderr ? write.apply(this, args) : true; };\n");
  const nonce = "4a33659c-f104-4f13-8c19-910c4e57c167";
  const entry = fileURLToPath(new URL("../../rind-runtime-client/shared-server.js", import.meta.url));
  const stuck = spawn(process.execPath, ["--import", pathToFileURL(preload).href, entry, JSON.stringify(runtimeOptions(home)), "--rind-host-nonce=" + nonce], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  stuck.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => { if (stuck.exitCode === null) stuck.kill("SIGKILL"); await removeRindHome(home); });
  for (let i = 0; i < 100 && !(await probeEndpoint(paths.endpoint)); i++) await sleep(50);
  assert.equal(await probeEndpoint(paths.endpoint), true, stderr);
  const host = await connectSharedRuntime(runtimeOptions(home));
  t.after(() => host.close());
  assert.equal(alive(stuck.pid), false);
  assert.notEqual((await host.request("runtime/info")).pid, stuck.pid);
  await host.request("runtime/shutdown").catch(() => {});
});

test("a detached host resolves relative launch paths in the caller's folder", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-relative-host-"));
  t.after(() => removeRindHome(home));
  const host = await connectSharedRuntime({ ...runtimeOptions(home), rindHome: path.relative(process.cwd(), home), repoRoot: path.relative(process.cwd(), repoRoot) || "." });
  t.after(() => host.close());
  await host.request("initialize");
  assert.ok((await host.request("runtime/info")).pid > 0);
  await host.request("runtime/shutdown").catch(() => {});
});
