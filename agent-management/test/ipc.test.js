import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../dist/ipc.js";
import { connectClient } from "../dist/client.js";

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
  const config = await a.request("sessionTools", { sessionId: session.id });
  const runtime = await connectClient({ endpoint: server.paths.endpoint, token: config.env.RIND_MANAGEMENT_TOKEN, runtimeSessionId: "runtime-1" });
  clients.push(runtime);
  assert.equal((await runtime.request("listTeams")).length, 1);
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
