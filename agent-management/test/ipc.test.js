import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../dist/ipc.js";
import { connectClient } from "../dist/client.js";
import { managementBuildId } from "../dist/build.js";
import { openStore } from "../dist/store.js";

test("direct host can reconcile after restart while its model cannot revive an expired session", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-restart-"));
  const options = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  let server = await startServer(options);
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await server.close(); await rm(home, { recursive: true, force: true }); });
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const connect = async (credential = token, runtimeSessionId) => {
    const client = await connectClient({ endpoint: server.paths.endpoint, token: credential, runtimeSessionId }); clients.push(client); return client;
  };
  const a = await connect();
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  const agent = await a.request("registerAgent", { workspace });
  const session = await a.request("attachSession", { agentId: agent.id });
  await a.request("bindSession", { sessionId: session.id, runtimeSessionId: "live" });
  const config = await a.request("sessionTools", { sessionId: session.id });
  await a.request("beginRun", { sessionId: session.id });
  await server.close(); server = await startServer(options);
  const model = await connect(config.env.RIND_MANAGEMENT_TOKEN, "live");
  await assert.rejects(model.request("snapshot"), { code: "SESSION_EXPIRED" });
  const b = await connect();
  assert.equal((await b.request("snapshot")).runs[0].status, "unknown");
  await b.request("reattachSession", { sessionId: session.id, runtimeSessionId: "live", active: true });
  await assert.rejects(model.request("report", { outcome: "done", summary: "s", evidence: [] }), { code: "NO_TASK" }, "the revived credential reaches the service again");
  const host = await connect(config.lifecycle.env.RIND_MANAGEMENT_TOKEN, "live");
  await host.request("hostTurnEnd", { outcome: "turn_completed", pending: false });
  assert.equal((await b.request("snapshot")).runs[0].status, "succeeded");
});

test("local service has one writer, scoped credentials, subscription and disconnect reconciliation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-"));
  const options = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(options);
  const clients = [];
  t.after(async () => { for (const c of clients) c.close(); await server.close(); await rm(home, { recursive: true, force: true }); });
  await assert.rejects(startServer(options));
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const snapshots = [];
  const a = await connectClient({ endpoint: server.paths.endpoint, token, onSnapshot: snapshot => snapshots.push(snapshot) });
  const b = await connectClient({ endpoint: server.paths.endpoint, token });
  clients.push(a, b);
  await a.request("subscribe", { afterSeq: 0 });
  await Promise.all([a.request("createTeam", { name: "A" }), b.request("createTeam", { name: "B" })]);
  assert.equal((await a.request("snapshot")).teams.length, 2);
  assert.ok(snapshots.length);
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  const agent = await a.request("registerAgent", { workspace });
  const team = (await a.request("listTeams"))[0];
  await a.request("addMember", { teamId: team.id, agentId: agent.id });
  await a.request("setLeader", { teamId: team.id, agentId: agent.id });
  const session = await a.request("attachSession", { agentId: agent.id, teamId: team.id });
  await a.request("bindSession", { sessionId: session.id, runtimeSessionId: "runtime-1" });
  const config = await a.request("sessionTools", { sessionId: session.id });
  const runtime = await connectClient({ endpoint: server.paths.endpoint, token: config.env.RIND_MANAGEMENT_TOKEN, runtimeSessionId: "runtime-1" });
  clients.push(runtime);
  assert.deepEqual(config.tools.map(tool => tool.name), ["delegate"], "a leader's conversation can delegate; only a task run reports");
  assert.match(config.tools[0].description, /persistent direct report/);
  assert.match(config.instructions, /Your direct reports: none\./);
  assert.match(config.instructions, /authoritative source for team state/);
  assert.doesNotMatch(config.instructions, /agents-management/);
  await assert.rejects(runtime.request("delegate", { to: agent.id, brief: "Myself" }), { code: "NOT_DIRECT_REPORT" });
  await assert.rejects(runtime.request("listTeams"), { code: "FORBIDDEN" });
  await assert.rejects(runtime.request("hostTurnEnd", { outcome: "turn_completed" }), { code: "FORBIDDEN" });
  const host = await connectClient({ endpoint: server.paths.endpoint, token: config.lifecycle.env.RIND_MANAGEMENT_TOKEN, runtimeSessionId: "runtime-1" });
  clients.push(host);
  await assert.rejects(host.request("createTeam", { name: "bad-host" }), { code: "FORBIDDEN" });
  await assert.rejects(runtime.request("createTeam", { name: "bad" }), { code: "FORBIDDEN" });
  const impostor = await connectClient({ endpoint: server.paths.endpoint, token: config.env.RIND_MANAGEMENT_TOKEN, runtimeSessionId: "runtime-2" });
  clients.push(impostor);
  await assert.rejects(impostor.request("snapshot"), { code: "UNAUTHORIZED" });
  const run = await a.request("beginRun", { sessionId: session.id });
  a.close();
  for (let i = 0; i < 30; i++) {
    const current = (await b.request("snapshot")).runs.find(r => r.id === run.id);
    if (current.status === "unknown") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("disconnected host must not remain live");
});

test("the service reports its build and refuses to stop while an agent is working", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-lifecycle-"));
  let shutdowns = 0;
  const server = await startServer({ home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)), onShutdown: () => { shutdowns++; } });
  t.after(async () => { await server.close(); await rm(home, { recursive: true, force: true }); });
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  const info = await client.request("serviceInfo");
  assert.equal(info.buildId, await managementBuildId());
  assert.equal(info.pid, process.pid);
  assert.equal(info.working, 0);
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  const agent = await client.request("registerAgent", { workspace });
  const session = await client.request("attachSession", { agentId: agent.id });
  await client.request("bindSession", { sessionId: session.id, runtimeSessionId: "live" });
  await client.request("beginRun", { sessionId: session.id });
  assert.equal((await client.request("serviceInfo")).conversations, 1);
  await assert.rejects(client.request("serviceShutdown"), { code: "SERVICE_BUSY", message: /1 agent is still working/ });
  assert.equal(shutdowns, 0, "a busy service keeps running");
});

test("stopping with stopAgents ends a busy service, and the next client starts a fresh one", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-stop-"));
  const options = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  let stopped;
  const exited = new Promise(resolve => { stopped = resolve; });
  const server = await startServer({ ...options, onShutdown: stopped });
  t.after(async () => { await server.close(); await rm(home, { recursive: true, force: true }); });
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  const workspace = path.join(home, "workspace"); await mkdir(workspace);
  const agent = await client.request("registerAgent", { workspace });
  const session = await client.request("attachSession", { agentId: agent.id });
  await client.request("bindSession", { sessionId: session.id, runtimeSessionId: "live" });
  await client.request("beginRun", { sessionId: session.id });
  const result = await client.request("serviceShutdown", { stopAgents: true });
  assert.deepEqual([result.stopping, result.working], [true, 1]);
  await exited;
  await assert.rejects(client.request("snapshot"), { code: "SERVICE_DISCONNECTED" });
  await assert.rejects(connectClient({ endpoint: server.paths.endpoint, token: "x" }), "the endpoint is closed after stopping");
});

test("the Manager keeps every Rind tool and is held to agent_management by its instructions", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-manager-"));
  const server = await startServer({ home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) });
  const user = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  t.after(async () => { user.close(); await server.close(); await rm(home, { recursive: true, force: true }); });
  const session = await user.request("attachSession", { manager: true });

  const config = await user.request("sessionTools", { sessionId: session.id });

  assert.deepEqual(config.tools.map(tool => tool.name), ["agent_management"]);
  assert.equal("enabled_tools" in config, false, "no allowlist narrows the built-in tools");
  assert.deepEqual(config.skill_files, []);
  assert.match(config.instructions, /only through agent_management/);
  assert.match(config.instructions, /never carry out that action another way/);
  const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;
  assert.ok(comparable(config.instructions).includes(comparable(await realpath(home))), "names the canonical Rind home it must not modify");
});

test("shared session credentials remain valid across management restart before and after first turn binding", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-shared-"));
  const options = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  let server = await startServer(options);
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await server.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const connect = async (credential = token, runtimeSessionId) => {
    const client = await connectClient({ endpoint: server.paths.endpoint, token: credential, runtimeSessionId }); clients.push(client); return client;
  };
  const user = await connect();
  const workspace = path.join(home, "workspace"), childWorkspace = path.join(home, "child");
  await mkdir(workspace); await mkdir(childWorkspace);
  const leader = await user.request("registerAgent", { workspace, name: "Lead" });
  const member = await user.request("registerAgent", { workspace: childWorkspace, name: "Builder" });
  const team = await user.request("createTeam", { name: "SharedTeam" });
  await user.request("addMember", { teamId: team.id, agentId: leader.id });
  await user.request("addMember", { teamId: team.id, agentId: member.id, reportsToAgentId: leader.id });
  await user.request("setLeader", { teamId: team.id, agentId: leader.id });

  const session = await user.request("attachSession", { agentId: leader.id, teamId: team.id });
  const config = await user.request("sessionTools", { sessionId: session.id });
  user.close();
  await server.close();
  const store = await openStore(server.paths.state);
  const next = structuredClone(store.state);
  next.sessions[session.id].shared = true;
  await store.commit(next);
  await store.close();
  server = await startServer(options);

  // Even after management restart while disconnected, hostTurnStart and delegate succeed on the shared session without SESSION_EXPIRED.
  const host = await connect(config.lifecycle.env.RIND_MANAGEMENT_TOKEN, "shared-runtime-1");
  const run = await host.request("hostTurnStart", {});
  assert.equal(run.status, "running");
  const model = await connect(config.env.RIND_MANAGEMENT_TOKEN, "shared-runtime-1");
  const waited = await model.request("delegate", { wait: true });
  assert.equal(waited.output, "No pending delegated work.");
  await host.request("hostTurnEnd", { outcome: "turn_completed", pending: false });
  const userAfter = await connect();
  const snap = await userAfter.request("snapshot");
  assert.equal(snap.runs.find(r => r.id === run.id).status, "succeeded");
  assert.equal(snap.sessions.find(s => s.id === session.id).runtimeSessionId, "shared-runtime-1");
});


test("service stops automatically when idle TTL expires or service.json is removed and logs lifecycle", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-idle-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  t.after(async () => { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  let idleStopped;
  const idleExited = new Promise(resolve => { idleStopped = resolve; });
  const server1 = await startServer({ home, repoRoot, idleTtlMs: 40, onShutdown: idleStopped });
  await idleExited;
  await server1.close();
  const logAfterIdle = await readFile(path.join(server1.paths.state, "service.log"), "utf8");
  assert.match(logAfterIdle, /service started/);
  assert.match(logAfterIdle, /reason=idle_timeout/);

  let recordStopped;
  const recordExited = new Promise(resolve => { recordStopped = resolve; });
  const server2 = await startServer({ home, repoRoot, idleTtlMs: 60_000, onShutdown: recordStopped });
  await rm(server2.paths.record, { force: true });
  await recordExited;
  await server2.close();
  const logAfterRecord = await readFile(path.join(server2.paths.state, "service.log"), "utf8");
  assert.match(logAfterRecord, /reason=record_removed/);
});

test("a service replaced in service.json stops while a client is still connected and leaves the replacement's record", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-superseded-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  t.after(async () => { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  let stopped;
  const exited = new Promise(resolve => { stopped = resolve; });
  const server = await startServer({ home, repoRoot, idleTtlMs: 60_000, onShutdown: stopped });
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  await client.request("snapshot");
  const successor = JSON.stringify({ pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() });
  await writeFile(server.paths.record, successor);
  await exited;
  client.close();
  await server.close();
  assert.equal(await readFile(server.paths.record, "utf8"), successor);
  assert.match(await readFile(path.join(server.paths.state, "service.log"), "utf8"), /reason=superseded/);
});

test("disconnecting an agent connection while waiting in delegate({ wait: true }) releases the wait without losing child results", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-wait-disconnect-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const server = await startServer({ home, repoRoot });
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await server.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const token = (await readFile(server.paths.token, "utf8")).trim();
  const connect = async (credential = token, runtimeSessionId) => {
    const client = await connectClient({ endpoint: server.paths.endpoint, token: credential, runtimeSessionId }); clients.push(client); return client;
  };
  const user = await connect();
  const leadDir = path.join(home, "lead"), childDir = path.join(home, "child");
  await mkdir(leadDir); await mkdir(childDir);
  const leader = await user.request("registerAgent", { workspace: leadDir, name: "Lead" });
  const child = await user.request("registerAgent", { workspace: childDir, name: "Worker" });
  const team = await user.request("createTeam", { name: "WaitDisconnectTeam" });
  await user.request("addMember", { teamId: team.id, agentId: leader.id });
  await user.request("addMember", { teamId: team.id, agentId: child.id, reportsToAgentId: leader.id });
  await user.request("setLeader", { teamId: team.id, agentId: leader.id });

  const childSession = await user.request("attachSession", { agentId: child.id, teamId: team.id });
  await user.request("bindSession", { sessionId: childSession.id, runtimeSessionId: "rt-child" });
  await user.request("beginRun", { sessionId: childSession.id });
  const session = await user.request("attachSession", { agentId: leader.id, teamId: team.id });
  await user.request("bindSession", { sessionId: session.id, runtimeSessionId: "rt-lead" });
  const config = await user.request("sessionTools", { sessionId: session.id });
  const host = await connect(config.lifecycle.env.RIND_MANAGEMENT_TOKEN, "rt-lead");
  await host.request("hostTurnStart", {});
  const model1 = await connect(config.env.RIND_MANAGEMENT_TOKEN, "rt-lead");
  const { taskId } = await model1.request("delegate", { to: child.id, brief: "compute" });

  const waiting = model1.request("delegate", { wait: true, timeoutMs: 30000 });
  await new Promise(resolve => setTimeout(resolve, 40));
  model1.close();
  await assert.rejects(waiting, { code: "CONNECTION_LOST" });
  await new Promise(resolve => setTimeout(resolve, 40));

  await server.close();
  const store = await openStore(server.paths.state);
  assert.equal(Boolean(store.state.delegations[taskId].returned), false, "disconnecting the bridge socket must not consume unreturned results");
  await store.close();
});

test("openStore rejects while store.lock is held, and a busy server steps down on nonce change so the new owner acquires store.lock without corrupting journal", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-ipc-record-busy-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  t.after(async () => { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const stateDir = path.join(home, "agents-management");
  await mkdir(stateDir, { recursive: true });
  const heldStore = await openStore(stateDir);
  await assert.rejects(openStore(stateDir), { code: "ALREADY_RUNNING" });
  await heldStore.close();

  let recordStopped;
  const recordExited = new Promise(resolve => { recordStopped = resolve; });
  const server1 = await startServer({ home, repoRoot, idleTtlMs: 60_000, onShutdown: recordStopped });
  const token = (await readFile(server1.paths.token, "utf8")).trim();
  const user1 = await connectClient({ endpoint: server1.paths.endpoint, token });
  const session = await user1.request("attachSession", { manager: true, shared: true });
  await user1.request("bindSession", { sessionId: session.id, runtimeSessionId: "rt-busy-mgr" });
  const run = await user1.request("beginRun", { sessionId: session.id });
  assert.equal(run.status, "starting");

  // Simulate a new server publishing its nonce to service.json while server1 is still busy and holding store.lock:
  await writeFile(server1.paths.record, JSON.stringify({ pid: process.pid, nonce: "00000000-0000-4000-8000-000000000002", startedAt: new Date().toISOString() }), { mode: 0o600 });
  // Immediately call openStore(server1.paths.state) while server1 is still running; it waits on store.lock until server1's idleTimer detects !recordOwned and releases store.lock:
  const takeoverStore = await openStore(server1.paths.state);
  await recordExited;
  user1.close();
  await server1.close();
  await takeoverStore.close();

  const log = await readFile(path.join(server1.paths.state, "service.log"), "utf8");
  assert.match(log, /reason=superseded/);

  // Before a new server recovers, the old server must NOT have written status="cancelled" into store:
  const rawEvents = await readFile(path.join(server1.paths.state, "events.jsonl"), "utf8");
  assert.doesNotMatch(rawEvents, /"status":"cancelled"/);

  // A replacement server starts and answers serviceInfo immediately even with a shared session awaiting background reconciliation:
  const t0 = Date.now();
  const server2 = await startServer({ home, repoRoot });
  const user2 = await connectClient({ endpoint: server2.paths.endpoint, token });
  const info = await user2.request("serviceInfo");
  assert.ok(Date.now() - t0 < 2000, "serviceInfo must respond without blocking on shared Runtime reconciliation");
  assert.equal(info.unconfirmed, 1);
  const snap = await user2.request("snapshot");
  assert.equal(snap.runs.find(r => r.id === run.id)?.status, "unknown");
  user2.close();
  await server2.close();
});
