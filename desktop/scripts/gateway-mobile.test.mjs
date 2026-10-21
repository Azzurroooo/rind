import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DesktopGateway, RemoteWebSocket as WebSocket } from "../../rind-runtime-client/remote/server.js";

test("packaged mobile origins require one-time tickets and share revocation", async (t) => {
  const web = await mkdtemp(join(tmpdir(), "rind-mobile-gateway-"));
  await writeFile(join(web, "index.html"), "Rind");
  const gateway = new DesktopGateway({ initialize: async () => ({}), request: async () => ({}), subscribe: () => () => {} }, web);
  t.after(async () => { await gateway.stop(); await rm(web, { recursive: true, force: true }); });
  const state = await gateway.start({ scope: "loopback", port: 0 });
  const base = state.addresses[0];
  const issue = async () => (await (await fetch(`${base}/ticket`, { headers: { Authorization: `Bearer ${state.accessCode}` } })).json()).ticket;
  const open = (origin, ticket) => new WebSocket(`${base.replace("http:", "ws:")}/ws?ticket=${ticket}`, { origin });
  for (const origin of ["http://rind.local", "capacitor://rind.local"]) {
    const ticket = await issue();
    const ws = open(origin, ticket); t.after(() => ws.terminate());
    await once(ws, "open");
    const reused = open(origin, ticket);
    await assert.rejects(once(reused, "open"), /401/);
  }
  for (const origin of ["http://rind.local.evil.test", "capacitor://evil.test", "null"]) {
    await assert.rejects(once(open(origin, await issue()), "open"), /401/);
  }
  await assert.rejects(once(open("http://rind.local", "invalid"), "open"), /401/);
  assert.equal((await fetch(`${base}/ticket`, { headers: { Origin: "http://rind.local", Authorization: `Bearer ${state.accessCode}` } })).status, 403, "native HTTP uses the OS transport; no browser CORS relaxation");
  gateway.rotate();
  assert.equal(gateway.state().clients, 0);
  assert.equal((await fetch(`${base}/ticket`, { headers: { Authorization: `Bearer ${state.accessCode}` } })).status, 401);
});

test("remote mobile clients sync existing Agents & Teams via initialize, agents/get, agents/request, and agents/update", async (t) => {
  const web = await mkdtemp(join(tmpdir(), "rind-mobile-agents-"));
  await writeFile(join(web, "index.html"), "Rind");
  let pushAgentsUpdate = null;
  const mockAgentsState = {
    connection: "connected",
    service: { pid: 1234 },
    snapshot: {
      seq: 3,
      teams: [{ id: "team-1", name: "Core Platform", leaderAgentId: "agent-1" }],
      agents: [{ id: "agent-1", name: "platform-lead", canonicalWorkspace: "E:/teams/core/lead" }],
      memberships: [{ teamId: "team-1", agentId: "agent-1", position: "Lead", status: "Idle" }],
      tasks: [],
      runs: [],
      sessions: [],
    },
  };

  const gateway = new DesktopGateway(
    {
      initialize: async () => ({ session_id: "sess-1", workspace_root: "E:/teams/core" }),
      request: async () => ({}),
      subscribe: () => () => {},
      agentsRequest: async (op, params) => {
        if (op === "getState") return mockAgentsState;
        if (op === "listSessions") return { sessions: [], teamId: params?.teamId || "" };
        return { op, params };
      },
      subscribeAgents: (listener) => {
        pushAgentsUpdate = listener;
        return () => {
          pushAgentsUpdate = null;
        };
      },
    },
    web,
  );
  t.after(async () => {
    await gateway.stop();
    await rm(web, { recursive: true, force: true });
  });

  const state = await gateway.start({ scope: "loopback", port: 0 });
  const base = state.addresses[0];
  const ticketRes = await fetch(`${base}/ticket`, {
    headers: { Authorization: `Bearer ${state.accessCode}` },
  });
  const { ticket } = await ticketRes.json();
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws?ticket=${ticket}`, {
    origin: "capacitor://rind.local",
  });
  t.after(() => ws.terminate());
  await once(ws, "open");

  const rpc = (request_id, method, params = {}) =>
    new Promise((resolveMsg, rejectMsg) => {
      const onMessage = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.kind === "response" && msg.request_id === request_id) {
          ws.off("message", onMessage);
          if (msg.error) rejectMsg(new Error(msg.error.message));
          else resolveMsg(msg.result);
        }
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ kind: "request", request_id, method, params }));
    });

  const initResult = await rpc("req-init", "initialize");
  assert.equal(initResult.methods.includes("agents/get"), true);
  assert.equal(initResult.methods.includes("agents/request"), true);
  assert.equal(initResult.gateway.agents, true);
  assert.equal(initResult.agents_state.snapshot.teams[0].name, "Core Platform");

  const getStateResult = await rpc("req-get", "agents/get");
  assert.equal(getStateResult.snapshot.teams.length, 1);
  assert.equal(getStateResult.snapshot.teams[0].id, "team-1");

  // Both `{ method, params }` (web client) and `{ operation, params }` are accepted
  const byMethodResult = await rpc("req-list-1", "agents/request", {
    method: "listSessions",
    params: { teamId: "team-1" },
  });
  assert.equal(byMethodResult.teamId, "team-1");

  const byOperationResult = await rpc("req-list-2", "agents/request", {
    operation: "listSessions",
    params: { teamId: "team-1" },
  });
  assert.equal(byOperationResult.teamId, "team-1");

  // Push update broadcasts `agents/update` with `type: "agents_changed"`
  const eventPromise = new Promise((resolveEvent) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.kind === "event" && msg.method === "agents/update") {
        ws.off("message", onMessage);
        resolveEvent(msg);
      }
    };
    ws.on("message", onMessage);
  });
  pushAgentsUpdate?.(mockAgentsState);
  const pushed = await eventPromise;
  assert.equal(pushed.event.type, "agents_changed");
  assert.equal(pushed.event.snapshot.teams[0].name, "Core Platform");
});
