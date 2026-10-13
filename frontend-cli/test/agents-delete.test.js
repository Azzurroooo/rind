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
import { createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
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
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" }));
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
