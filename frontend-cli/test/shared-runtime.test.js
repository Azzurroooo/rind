import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { startSharedServer } from "../../rind-runtime-client/shared-server.js";
import { connectSharedRuntime, createSharedRuntimeClient, sharedRuntimePaths, stopSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import { probeEndpoint } from "../../rind-runtime-client/endpoint.js";
import { resolveRindHome } from "../../rind-runtime-client/local-files.js";
import { managementPaths } from "../../agent-management/dist/paths.js";
import { stopManagementService } from "../../agent-management/dist/client.js";
import { startServer } from "../../agent-management/dist/ipc.js";
import { runOneShot } from "../lib/one-shot.js";
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

test("one-shot run stops a shared host it spawned when idle, preserves an existing or shared host, and writes lifecycle logs", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-oneshot-lifecycle-"));
  const work = path.join(home, "work");
  await mkdir(work, { recursive: true });
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" } } }));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const python = process.env.RIND_PYTHON || "python";
  const previousHome = process.env.RIND_HOME;
  process.env.RIND_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = previousHome;
    await stopSharedRuntime({ rindHome: home });
    await new Promise(resolve => provider.close(resolve));
    await removeRindHome(home);
  });

  const stdout = [], stderr = [];
  await runOneShot({
    args: ["run", "--dir", work, "--prompt", "Reply"],
    python, repoRoot, cwd: work,
    stdout: text => stdout.push(text),
    stderr: text => stderr.push(text),
  });
  assert.deepEqual(stdout, ["Done."]);
  const paths = sharedRuntimePaths(home);
  await assert.rejects(connectSharedRuntime({ rindHome: home, start: false }), "host spawned by one-shot run must stop when the run finishes");
  assert.equal(existsSync(paths.record), false);
  const logText = await readFile(paths.log, "utf8");
  assert.match(logText, /host started pid=\d+/);
  assert.match(logText, /worker started pid=\d+ workerPid=\d+/);
  assert.match(logText, /host stopped pid=\d+ workerPid=\d+ reason=shutdown/);

  // When a host is already running before one-shot starts, one-shot leaves it running.
  const existing = await connectSharedRuntime({ rindHome: home, python, repoRoot });
  assert.equal(existing.spawned, true);
  existing.close();
  await runOneShot({
    args: ["run", "--dir", work, "--prompt", "Reply again"],
    python, repoRoot, cwd: work,
    stdout: text => stdout.push(text),
    stderr: text => stderr.push(text),
  });
  const stillRunning = await connectSharedRuntime({ rindHome: home, start: false });
  assert.equal(stillRunning.spawned, false);
  stillRunning.close();
  await stopSharedRuntime({ rindHome: home });

  // When a spawned host is joined by another window before shutdown, stopSpawnedHost leaves it up for that window.
  const firstClient = createSharedRuntimeClient({ rindHome: home, python, repoRoot, cwd: work, cliArgs: ["--cwd", work], stopSpawnedHost: true });
  await firstClient.request("initialize");
  const secondWindow = createSharedRuntimeClient({ rindHome: home, python, repoRoot, cwd: work, cliArgs: ["--cwd", work] });
  await secondWindow.request("initialize");
  await firstClient.shutdown();
  const afterFirst = await connectSharedRuntime({ rindHome: home, start: false });
  afterFirst.close();
  await secondWindow.shutdown();
  await stopSharedRuntime({ rindHome: home });
});

test("idle TTL and record removal automatically stop an unattached shared host", { timeout: 25000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-idle-ttl-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot };
  t.after(async () => { await stopSharedRuntime(options); await removeRindHome(home); });

  // 1. Idle timeout stops the host after all peers disconnect.
  const host1 = await startSharedServer({ ...options, idleTtlMs: 120 });
  const peer = await connectSharedRuntime({ ...options, start: false });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(existsSync(host1.paths.record), true, "connected peer keeps host alive past idleTtlMs");
  peer.close();
  for (let i = 0; i < 40 && existsSync(host1.paths.record); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(existsSync(host1.paths.record), false, "unattached host stops after idleTtlMs");
  assert.match(await readFile(host1.paths.log, "utf8"), /reason=idle_timeout/);

  // 2. Removing host.json while unattached stops the host automatically.
  const host2 = await startSharedServer({ ...options, idleTtlMs: 60000 });
  await unlink(host2.paths.record);
  let gone = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const conn = await connectSharedRuntime({ ...options, start: false }).catch(() => null);
    if (!conn) { gone = true; break; }
    conn.close();
  }
  assert.equal(gone, true, "unattached host stops when its record file is removed");
});

test("a host replaced in host.json stops while a window is still attached and leaves the replacement's record", { timeout: 25000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-superseded-host-"));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  t.after(async () => { await stopSharedRuntime(options); await removeRindHome(home); });
  const host = await startSharedServer({ ...options, idleTtlMs: 60000 });
  const window = await connectSharedRuntime({ ...options, start: false });
  const successor = JSON.stringify({ pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() });
  await writeFile(host.paths.record, successor);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    gone = !(await connectSharedRuntime({ ...options, start: false }).then(conn => { conn.close(); return true; }, () => false));
  }
  window.close();
  assert.equal(gone, true, "the replaced host stops serving although a window is attached");
  assert.equal(await readFile(host.paths.record, "utf8"), successor);
  assert.match(await readFile(host.paths.log, "utf8"), /reason=superseded/);
});

test("every line of a detached host's Runtime log carries a time, including the worker's stderr", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-log-time-"));
  // A worker that fails at once writes a multi-line error to stderr.
  const options = { rindHome: home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)), runtimePath: process.execPath };
  t.after(async () => { await stopSharedRuntime(options); await removeRindHome(home); });
  const runtime = await connectSharedRuntime(options);
  await assert.rejects(runtime.request("initialize"));
  runtime.close();
  const { log } = sharedRuntimePaths(home);
  let text = "";
  for (let i = 0; i < 100 && !/host stopped/.test(text); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    text = await readFile(log, "utf8").catch(() => "");
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.some(line => /Cannot find module/.test(line)), "the worker's own stderr reached the log");
  for (const line of lines) assert.match(line, /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /);
});

test("one-shot leaves zero orphan processes across plain and registered folders, normal exit, and abrupt SIGKILL", { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-oneshot-no-orphans-"));
  const plainDir = path.join(home, "plain");
  const memberDir = path.join(home, "member");
  await mkdir(plainDir, { recursive: true });
  await mkdir(memberDir, { recursive: true });
  let mode = "immediate", heldResponse = null, notifyHeld = null;
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      if (mode === "hold") {
        heldResponse = response;
        notifyHeld?.();
        return;
      }
      const body = JSON.parse(raw || "{}");
      const hasToolResult = (body.messages || []).some(m => m.role === "tool");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "bg_task" && !hasToolResult) {
        const call = { index: 0, id: "bg-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, yield_time_ms: 50, notify: "on_exit" }) } };
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      if (mode === "bg_task" && hasToolResult) {
        notifyHeld?.();
      }
      response.write('data: {"choices":[{"index":0,"delta":{"content":"OK."},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" } } }));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));
  const python = process.env.RIND_PYTHON || "python";
  const rtPaths = sharedRuntimePaths(home);
  const mgmtPaths = managementPaths(home);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

  t.after(async () => {
    heldResponse?.destroy();
    await stopManagementService({ home }).catch(() => {});
    await stopSharedRuntime({ rindHome: home }).catch(() => {});
    await new Promise(resolve => provider.close(resolve));
    await removeRindHome(home);
  });

  // Register a team and member first, then stop the management service so user-token exists on disk while nothing is running.
  const setupServer = await startServer({ home, repoRoot, python });
  const { connectClient } = await import("../../agent-management/dist/client.js");
  const setupClient = await connectClient({ endpoint: setupServer.paths.endpoint, token: (await readFile(setupServer.paths.token, "utf8")).trim() });
  const agent = await setupClient.request("registerAgent", { workspace: memberDir, name: "Worker" });
  const team = await setupClient.request("createTeam", { name: "Alpha" });
  await setupClient.request("addMember", { teamId: team.id, agentId: agent.id });
  setupClient.close();
  await setupServer.close();
  assert.equal(existsSync(mgmtPaths.token), true, "user-token exists on disk");
  assert.equal(await probeEndpoint(mgmtPaths.endpoint), false);
  assert.equal(await probeEndpoint(rtPaths.endpoint), false);

  const runCli = (cwd, ...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rindBin, ...args], {
      cwd,
      env: { ...process.env, RIND_HOME: home, RIND_PYTHON: python, NO_COLOR: "1" },
      windowsHide: true,
    });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, out, err }));
  });

  // 1. Plain unregistered folder when user-token exists and no Rind is running: neither server.js nor shared-server.js remains.
  const plainRes = await runCli(plainDir, "run", "--dir", plainDir, "--prompt", "Plain reply");
  assert.equal(plainRes.code, 0, plainRes.err);
  assert.match(plainRes.out, /OK\./);
  assert.equal(await probeEndpoint(mgmtPaths.endpoint), false, "management service spawned for folder check must stop");
  assert.equal(await probeEndpoint(rtPaths.endpoint), false, "runtime host spawned for one-shot must stop");
  assert.equal(existsSync(mgmtPaths.record), false);
  assert.equal(existsSync(rtPaths.record), false);

  // 2. Registered member folder when no Rind is running: both server.js and shared-server.js stop on completion.
  const memberRes = await runCli(memberDir, "run", "--dir", memberDir, "--prompt", "Member reply");
  assert.equal(memberRes.code, 0, memberRes.err);
  assert.match(memberRes.out, /OK\./);
  assert.equal(await probeEndpoint(mgmtPaths.endpoint), false, "management service spawned for one-shot must stop");
  assert.equal(await probeEndpoint(rtPaths.endpoint), false, "runtime host spawned via sessionTools must stop");

  // 3. Abrupt SIGKILL of `rind run` mid-turn when no Rind was running: turn is cancelled and both spawned daemons exit automatically.
  mode = "hold";
  const heldArrived = new Promise(resolve => { notifyHeld = resolve; });
  const killedChild = spawn(process.execPath, [rindBin, "run", "--dir", memberDir, "--prompt", "Hold reply"], {
    cwd: memberDir,
    env: { ...process.env, RIND_HOME: home, RIND_PYTHON: python, NO_COLOR: "1" },
    windowsHide: true,
  });
  await heldArrived;
  const rtRecordBeforeKill = JSON.parse(await readFile(rtPaths.record, "utf8"));
  const mgmtRecordBeforeKill = JSON.parse(await readFile(mgmtPaths.record, "utf8"));
  const killedExit = new Promise(resolve => killedChild.once("exit", resolve));
  killedChild.kill("SIGKILL");
  await killedExit;
  heldResponse?.destroy();
  heldResponse = null;
  for (let i = 0; i < 100 && (alive(rtRecordBeforeKill.pid) || alive(rtRecordBeforeKill.workerPid) || alive(mgmtRecordBeforeKill.pid)); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(alive(rtRecordBeforeKill.pid), false, "spawned shared-server exits after one-shot SIGKILL");
  assert.equal(alive(rtRecordBeforeKill.workerPid), false, "spawned python worker exits after one-shot SIGKILL");
  assert.equal(alive(mgmtRecordBeforeKill.pid), false, "spawned management server exits after one-shot SIGKILL");

  // 4. Existing Rind running when `rind run` starts a background bash task and is killed with SIGKILL:
  //    existing host stays alive while the one-shot's background bash task is terminated.
  const existingHost = await connectSharedRuntime({ rindHome: home, python, repoRoot });
  t.after(() => existingHost.close());
  await existingHost.request("initialize");
  const hostInfoBefore = await existingHost.request("runtime/info");
  const workerBefore = await existingHost.request("runtime/observe");
  mode = "bg_task";
  const bgWaitArrived = new Promise(resolve => { notifyHeld = resolve; });
  const bgChild = spawn(process.execPath, [rindBin, "run", "--dir", plainDir, "--prompt", "Start bg"], {
    cwd: plainDir,
    env: { ...process.env, RIND_HOME: home, RIND_PYTHON: python, NO_COLOR: "1" },
    windowsHide: true,
  });
  await bgWaitArrived;
  // Wait briefly so run_turn finishes and wait_request is actively waiting on the background bash process.
  await new Promise(resolve => setTimeout(resolve, 200));
  const bgChildExit = new Promise(resolve => bgChild.once("exit", resolve));
  bgChild.kill("SIGKILL");
  await bgChildExit;

  let sessions = [];
  for (let i = 0; i < 60; i++) {
    sessions = (await existingHost.request("runtime/sessions")).sessions || [];
    if (sessions.every(s => s.turn === "idle" && !s.background)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(sessions.every(s => s.turn === "idle" && !s.background), "background bash task from killed one-shot is cancelled");
  assert.equal((await existingHost.request("runtime/info")).pid, hostInfoBefore.pid, "existing shared host stays alive");
  assert.equal((await existingHost.request("runtime/observe")).pid, workerBefore.pid, "existing python worker stays alive");
});

