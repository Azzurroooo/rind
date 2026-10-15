// Deleting a conversation from Agents management: the service removes the
// Runtime's saved history, refuses while it runs or a window shows it, and the
// action menu offers it on every conversation row.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { createSharedRuntimeClient, connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import { prepareManagement } from "../lib/agents-session.js";
import { createActions } from "../lib/agents-actions.js";
import { emptyAgentsSnapshot } from "../lib/agents-model.js";

test("every conversation row offers deletion behind a confirmation", async () => {
  const dialogs = [], calls = [];
  const ui = {
    view: { snapshot: emptyAgentsSnapshot() },
    choose: (title, items, options) => dialogs.push({ title, items, options }),
    confirm: (title, description, label, action) => action(),
    deleteConversation: async runtimeSessionId => { calls.push(runtimeSessionId); return { deleted: true }; },
    notify() {},
  };
  const actions = createActions(ui);
  for (const row of [{ kind: "session", title: "Notes", sessionId: "r1", agentId: "a", workspace: "/w", independent: true },
    { kind: "session", title: "Review", sessionId: "r2", agentId: "a", teamId: "t" }]) {
    actions.sessionActions(row);
    const menu = dialogs[dialogs.length - 1];
    const item = menu.items.find(entry => entry.label === "Delete conversation…");
    assert.ok(item, "the row offers deletion");
    assert.equal(item.danger, true);
    await item.action();
  }
  assert.deepEqual(calls, ["r1", "r2"], "the confirmation runs the deletion for the selected conversation");
});

test("deleting a saved conversation removes it and refuses while it runs or is shown", { timeout: 120000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-delete-session-"));
  const workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const held = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    request.resume();
    request.on("end", () => held.push(response));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture" }));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }));
  await writeFile(path.join(home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { api: "openai-chat", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" } } }));
  const launch = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(launch);
  const window = createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: launch.repoRoot, cliArgs: ["--cwd", workspace], onMessage() {} });
  let client;
  t.after(async () => {
    held.forEach(response => response.destroy());
    client?.close();
    await window.shutdown().catch(() => {});
    await server.close();
    await new Promise(resolve => provider.close(resolve));
    await (await import("./helpers/rind-home.js")).removeRindHome(home);
  });
  client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });

  await window.request("initialize");
  const sessionId = (await window.request("session/create", {})).session_id;
  const turn = window.request("session/prompt", { session_id: sessionId, input: "hello" }).catch(() => {});
  for (let i = 0; i < 300 && !held.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held.length, "the turn reached the provider");
  await assert.rejects(client.request("deleteSession", { runtimeSessionId: sessionId }), { code: "SESSION_BUSY" }, "a running conversation is not deleted");

  await window.request("session/cancel", { session_id: sessionId });
  await turn;
  await assert.rejects(client.request("deleteSession", { runtimeSessionId: sessionId }), { code: "SESSION_OPEN" }, "a shown conversation is not deleted");
  const host = await connectSharedRuntime({ rindHome: home, start: false });
  try {
    await assert.rejects(host.request("session/delete", { session_id: sessionId }), { code: "SESSION_OPEN" }, "the host also protects shown sessions from direct callers");
    const [created, removed] = await Promise.allSettled([
      host.request("session/create", { session_id: "opening-race", workspace_root: workspace }),
      host.request("session/delete", { session_id: "opening-race" }),
    ]);
    assert.equal(created.status, "fulfilled");
    assert.equal(removed.status, "rejected");
    assert.equal(removed.reason.code, "SESSION_BUSY");
  } finally { host.close(); }

  await window.shutdown();
  for (let i = 0; i < 50; i++) {
    try { await client.request("deleteSession", { runtimeSessionId: sessionId }); break; }
    catch (error) { if (error.code !== "SESSION_OPEN") throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(existsSync(path.join(home, "sessions", sessionId)), false, "its saved history is gone");
  const independent = await client.request("listSessions", { independent: true });
  assert.ok(!independent.workspaces.some(group => group.sessions.some(session => session.runtimeSessionId === sessionId)), "every list drops it");
  await assert.rejects(client.request("deleteSession", { runtimeSessionId: sessionId }), { code: "SessionNotFound" }, "it cannot be deleted twice");
});

test("a hidden managed window renews its binding and tools after its conversation is deleted", { timeout: 90000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-delete-managed-"));
  const launch = { home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(launch);
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  let management, window;
  t.after(async () => {
    await window?.shutdown(); await management?.close(); client.close(); await server.close();
    await (await import("./helpers/rind-home.js")).removeRindHome(home);
  });
  const team = await client.request("createTeam", { name: "Delegation recovery" });
  const lead = await client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  await client.request("setLeader", { teamId: team.id, agentId: lead.id });
  const agent = await client.request("createWorkspace", { teamId: team.id, name: "Worker", reportsToAgentId: lead.id });
  management = await prepareManagement(["--cwd", lead.canonicalWorkspace, "--team", team.id], launch, { interactive: true });
  window = createSharedRuntimeClient({ rindHome: home, python: launch.python, repoRoot: launch.repoRoot,
    cliArgs: management.args, externalTools: management.externalTools, onMessage(message) {
      if (message.event?.type === "session_deleted") management.sessionDeleted(message.session_id);
    } });
  await window.request("initialize");
  const original = await window.request("session/create");
  await management.bind(original);
  const oldToken = management.externalTools.env.RIND_MANAGEMENT_TOKEN;
  await window.setVisible(false);
  await client.request("deleteSession", { runtimeSessionId: original.session_id });
  await assert.rejects(client.request("deleteSession", { runtimeSessionId: original.session_id }), { code: "SessionNotFound" });
  await Promise.all([management.before("session/create", {}), management.before("session/create", {})]);
  const replacement = await window.request("session/create");
  await management.bind(replacement);
  assert.notEqual(replacement.session_id, original.session_id);
  const token = management.externalTools.env.RIND_MANAGEMENT_TOKEN;
  assert.notEqual(token, oldToken);
  const scoped = await connectClient({ endpoint: server.paths.endpoint, token, runtimeSessionId: replacement.session_id });
  try {
    const { taskId } = await scoped.request("delegate", { to: agent.id, brief: "Queued local fixture" });
    assert.deepEqual(await management.pendingDelegations(replacement.session_id), [{ taskId, assignee: agent.name, sessionId: replacement.session_id }]);
    assert.deepEqual(await management.pendingDelegations(original.session_id), []);
    await scoped.request("delegate", { task: taskId, cancel: true });
    assert.deepEqual(await management.pendingDelegations(replacement.session_id), []);
  } finally { scoped.close(); }
  const snapshot = await client.request("snapshot");
  assert.ok(snapshot.sessions.some(s => s.runtimeSessionId === replacement.session_id));
  assert.ok(!snapshot.sessions.some(s => s.runtimeSessionId === original.session_id));
  assert.equal(snapshot.sessions.filter(s => s.agentId === lead.id).length, 1, "concurrent requests share one replacement registration");
});
