// The Independent page loads one bounded page per folder: the newest few plus
// each folder's count, with team conversations excluded by id. The folder's
// own page reads its fuller list on demand.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { removeRindHome } from "./helpers/rind-home.js";

const entry = (id, workspace, updatedAt) => ({ id, workspace_root: workspace, updated_at: updatedAt, has_user_message: true, title: id });

test("independent listing is one bounded page per folder with truthful counts", { timeout: 120000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-independent-"));
  const alpha = path.join(home, "alpha"), beta = path.join(home, "beta"), other = path.join(home, "other");
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(other)]);
  const index = { sessions: [
    ...Array.from({ length: 5 }, (_, i) => entry(`20261001_a${i}`, alpha, `2026-10-0${i + 1}T00:00:00Z`)),
    ...Array.from({ length: 2 }, (_, i) => entry(`20261001_b${i}`, beta, `2026-10-0${i + 1}T00:00:00Z`)),
    entry("20261001_o0", other, "2026-10-01T00:00:00Z"),
    entry("20261001_team", alpha, "2026-10-06T00:00:00Z"),
    entry("20261001_manager", path.join(home, "agents-management", "manager"), "2026-10-06T00:00:00Z"),
  ] };
  await writeFile(path.join(home, "session_index.json"), JSON.stringify(index));
  const server = await startServer({ home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) });
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  t.after(async () => { client.close(); await server.close(); await removeRindHome(home); });

  // A team owns one of alpha's conversations; it must not appear, nor be counted.
  const team = await client.request("createTeam", { name: "Product" });
  const agent = await client.request("registerAgent", { workspace: alpha, name: "Alpha" });
  await client.request("addMember", { teamId: team.id, agentId: agent.id });
  const session = await client.request("attachSession", { agentId: agent.id, teamId: team.id });
  await client.request("bindSession", { sessionId: session.id, runtimeSessionId: "20261001_team" });

  const started = Date.now();
  const overview = await client.request("listSessions", { independent: true });
  const elapsed = Date.now() - started;
  const groups = Object.fromEntries(overview.workspaces.map(group => [group.name, group]));
  assert.deepEqual(Object.keys(groups).sort(), ["Alpha", "beta", "other"], "the Manager's folder is not independent");
  assert.equal(groups.Alpha.agentId, agent.id, "a registered folder keeps its agent");
  assert.equal(groups.Alpha.total, 5, "the team conversation is not counted");
  assert.equal(groups.Alpha.sessions.length, 3, "at most three conversations are loaded per folder");
  assert.ok(!groups.Alpha.sessions.some(s => s.runtimeSessionId === "20261001_team"));
  assert.deepEqual(groups.Alpha.sessions.map(s => s.runtimeSessionId), ["20261001_a4", "20261001_a3", "20261001_a2"], "newest first");
  assert.equal(groups.beta.total, 2);
  assert.deepEqual(groups.beta.sessions.map(s => s.runtimeSessionId), ["20261001_b1", "20261001_b0"]);
  assert.deepEqual(groups.other.sessions.map(s => s.runtimeSessionId), ["20261001_o0"]);

  const folder = await client.request("listSessions", { independent: true, workspace: alpha });
  assert.deepEqual(folder.sessions.map(s => s.runtimeSessionId), ["20261001_a4", "20261001_a3", "20261001_a2", "20261001_a1", "20261001_a0"]);

  // Repeated overview loads stay cheap: one index scan for every folder, not one per folder.
  const times = [];
  for (let i = 0; i < 5; i++) { const at = Date.now(); await client.request("listSessions", { independent: true }); times.push(Date.now() - at); }
  assert.ok(Math.max(...times) < 1500, `overview loads stay cheap: ${times.join(", ")} ms (first ${elapsed} ms)`);

  // Exercise paging through management IPC and the actual Python index, rather
  // than a mock that already understands the exclusion protocol.
  index.sessions.push(...Array.from({ length: 200 }, (_, i) => entry(`older_${i}`, alpha, "2025-01-01T00:00:00Z")));
  await writeFile(path.join(home, "session_index.json"), JSON.stringify(index));
  const loaded = [];
  const sizes = [];
  for (let page = 0; page < 3; page++) {
    const result = await client.request("listSessions", { independent: true, workspace: alpha, excludeSessionIds: loaded.map(s => s.runtimeSessionId) });
    sizes.push(result.sessions.length); loaded.push(...result.sessions);
  }
  assert.deepEqual(sizes, [100, 100, 5]);
  assert.equal(new Set(loaded.map(s => s.runtimeSessionId)).size, 205);
  assert.ok(!loaded.some(s => s.runtimeSessionId === "20261001_team"));
  await assert.rejects(client.request("listSessions", { independent: true, workspace: alpha, excludeSessionIds: [1] }), { code: "INVALID_INPUT" });
});
