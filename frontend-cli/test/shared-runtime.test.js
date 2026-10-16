import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { connectSharedRuntime, createSharedRuntimeClient, sharedRuntimePaths, stopSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import { resolveRindHome } from "../../rind-runtime-client/local-files.js";
import { managementPaths } from "../../agent-management/dist/paths.js";
import { startServer } from "../../agent-management/dist/ipc.js";
import { removeRindHome } from "./helpers/rind-home.js";

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
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" } } }));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const host = await startSharedServer(options);
  const eventsA = [], eventsB = [];
  const tool = { command: process.execPath, args: [], env: {}, tools: [{ name: "host_fixture", description: "Fixture", parameters: { type: "object", properties: {} } }] };
  const first = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", a], externalTools: tool, onMessage: event => eventsA.push(event) });
  const second = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", b], onMessage: event => eventsB.push(event) });
  const admin = await connectSharedRuntime({ ...options, start: false });
  t.after(async () => { await first.shutdown(); await second.shutdown(); admin.close(); responses.forEach(r => r.end()); await host.close(); await new Promise(resolve => provider.close(resolve)); await removeRindHome(home); });
  // Each window's first message creates its conversation.
  await first.request("initialize"); await second.request("initialize");
  const infoA = await first.request("session/create", {}), infoB = await second.request("session/create", {});
  assert.notEqual(infoA.session_id, infoB.session_id);
  assert.equal(await realpath(infoA.workspace_root), await realpath(a));
  assert.equal(await realpath(infoB.workspace_root), await realpath(b));
  const pidA = await first.request("runtime/observe"), pidB = await second.request("runtime/observe");
  assert.equal(pidA.pid, pidB.pid);
  // Use separate ordinary connections to test event filtering, plus an observer to verify delta suppression.
  await first.shutdown(); await second.shutdown();
  const observedEvents = [];
  const observer = await connectSharedRuntime({ ...options, start: false, onMessage: e => observedEvents.push(e) });
  await observer.request("runtime/observe");
  const one = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", a, "--session", infoA.session_id], externalTools: tool, onMessage: e => eventsA.push(e) });
  const two = createSharedRuntimeClient({ ...options, cliArgs: ["--cwd", b, "--session", infoB.session_id], onMessage: e => eventsB.push(e) });
  t.after(async () => { observer.close(); await one.shutdown(); await two.shutdown(); });
  await one.request("initialize"); await two.request("initialize");
  const turnA = one.request("session/prompt", { session_id: infoA.session_id, input: "A" }).catch(error => error);
  const turnB = two.request("session/prompt", { session_id: infoB.session_id, input: "B" });
  for (let i = 0; requests.length < 2 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 20));
  // Joining live execution may adjust presentation instructions, but cannot change its tool authority.
  const joined = await admin.request("session/open", { workspace_root: a, session_id: infoA.session_id, external_tools: { ...tool, instructions: "Updated role wording" } });
  assert.equal(joined.session_id, infoA.session_id);
  await assert.rejects(admin.request("session/open", { workspace_root: a, session_id: infoA.session_id }), /running session/);
  assert.equal(requests.length, 2, "both model requests must be in flight at once");
  const hosted = requests.find(r => r.messages.some(m => m.role === "user" && m.content === "A"));
  const names = request => request.tools.map(t => t.function.name);
  assert.ok(names(hosted).includes("host_fixture") && names(hosted).includes("bash"), "a host tool joins the built-in tools of its own session");
  assert.ok(!names(requests.find(r => r !== hosted)).includes("host_fixture"), "and never reaches another session");
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
  assert.ok(eventsB.some(event => event.event?.type === "assistant_delta"), "subscribed session client receives streaming deltas");
  assert.ok(observedEvents.some(event => event.event?.type === "turn_started") && observedEvents.some(event => event.event?.type === "turn_completed"), "observer receives turn lifecycle events");
  assert.ok(!observedEvents.some(event => event.event?.type === "assistant_delta"), "observer is not flooded with streaming deltas");
  await assert.rejects(admin.request("session/open", { workspace_root: b, session_id: infoA.session_id }), /workspace/i);
});

test("resolveRindHome, sharedRuntimePaths, and managementPaths canonicalize symlinks, relative paths, and tilde", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-canonical-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realHome = path.join(root, "real-home");
  const linkHome = path.join(root, "link-home");
  await symlink(realHome, linkHome, process.platform === "win32" ? "junction" : "dir");
  const beforeCreate = resolveRindHome(linkHome);
  await mkdir(realHome, { recursive: true });
  const afterCreate = resolveRindHome(linkHome);
  assert.equal(beforeCreate, afterCreate);
  assert.equal(resolveRindHome(realHome), afterCreate);
  assert.equal(resolveRindHome(path.relative(process.cwd(), linkHome) + path.sep), afterCreate);
  assert.equal(resolveRindHome("~/.rind-test-canonical"), path.join(resolveRindHome(os.homedir()), ".rind-test-canonical"));
  assert.deepEqual(sharedRuntimePaths(linkHome), sharedRuntimePaths(realHome));
  assert.deepEqual(managementPaths(linkHome), managementPaths(realHome));
});

test("second startSharedServer or startServer instance for the same RIND_HOME is rejected immediately", { timeout: 20000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-singleton-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot };
  const host = await startSharedServer(options);
  const management = await startServer({ home, repoRoot });
  t.after(async () => {
    await management.close();
    await host.close();
    await removeRindHome(home);
  });
  await assert.rejects(startSharedServer(options), /already running/i);
  await assert.rejects(startServer({ home, repoRoot }), /already running/i);
});

test("host.json records workerPid and stopSharedRuntime cleans up orphaned worker when shared-server is killed", { timeout: 25000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-orphan-worker-"));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  t.after(async () => { await stopSharedRuntime(options); await removeRindHome(home); });
  const connection = await connectSharedRuntime(options);
  await connection.request("initialize");
  const observed = await connection.request("runtime/observe");
  connection.close();
  const paths = sharedRuntimePaths(home);
  const record = JSON.parse(await readFile(paths.record, "utf8"));
  assert.equal(record.workerPid, observed.pid);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(record.pid), true);
  assert.equal(alive(record.workerPid), true);
  process.kill(record.pid, "SIGKILL");
  await stopSharedRuntime(options);
  assert.equal(alive(record.pid), false);
  assert.equal(alive(record.workerPid), false);
  assert.equal(existsSync(paths.record), false);
});
