// The Independent page loads one bounded page per folder: the newest few plus
// each folder's count, with team member and Manager folders strictly excluded.
// A standalone folder's own page reads its fuller list on demand.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { removeRindHome } from "./helpers/rind-home.js";
import { canonicalDirectory } from "../../rind-runtime-client/remote/workspaces.js";

const entry = (id, workspace, updatedAt) => ({ id, workspace_root: workspace, updated_at: updatedAt, has_user_message: true, title: id });

test("independent listing is one bounded page per folder with truthful counts", { timeout: 120000 }, async t => {
  const home = await canonicalDirectory(await mkdtemp(path.join(os.tmpdir(), "rind-independent-")));
  const alpha = path.join(home, "alpha"), beta = path.join(home, "beta"), other = path.join(home, "other");
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(other)]);
  const index = { sessions: [
    ...Array.from({ length: 5 }, (_, i) => entry(`20261001_b${i}`, beta, `2026-10-0${i + 1}T00:00:00Z`)),
    ...Array.from({ length: 2 }, (_, i) => entry(`20261001_a${i}`, alpha, `2026-10-0${i + 1}T00:00:00Z`)),
    entry("20261001_o0", other, "2026-10-01T00:00:00Z"),
    entry("20261001_team", alpha, "2026-10-06T00:00:00Z"),
    entry("20261001_manager", path.join(home, "agents-management", "manager"), "2026-10-06T00:00:00Z"),
  ] };
  await writeFile(path.join(home, "session_index.json"), JSON.stringify(index));
  const server = await startServer({ home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) });
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  t.after(async () => { client.close(); await server.close(); await removeRindHome(home); });

  // A team member folder (alpha) and the Manager folder must never appear in Independent;
  // a standalone registered folder (beta) keeps its agent identity and bounded pagination.
  const team = await client.request("createTeam", { name: "Product" });
  const alphaAgent = await client.request("registerAgent", { workspace: alpha, name: "Alpha" });
  const betaAgent = await client.request("registerAgent", { workspace: beta, name: "Beta" });
  await client.request("addMember", { teamId: team.id, agentId: alphaAgent.id });
  const session = await client.request("attachSession", { agentId: alphaAgent.id, teamId: team.id });
  await client.request("bindSession", { sessionId: session.id, runtimeSessionId: "20261001_team" });

  const started = Date.now();
  const overview = await client.request("listSessions", { independent: true });
  const elapsed = Date.now() - started;
  const groups = Object.fromEntries(overview.workspaces.map(group => [group.name, group]));
  assert.deepEqual(Object.keys(groups).sort(), ["Beta", "other"], "team member and Manager folders are excluded from Independent");
  assert.equal(groups.Beta.agentId, betaAgent.id, "a standalone registered folder keeps its agent");
  assert.equal(groups.Beta.total, 5);
  assert.equal(groups.Beta.sessions.length, 3, "at most three conversations are loaded per folder");
  assert.deepEqual(groups.Beta.sessions.map(s => s.runtimeSessionId), ["20261001_b4", "20261001_b3", "20261001_b2"], "newest first");
  assert.deepEqual(groups.other.sessions.map(s => s.runtimeSessionId), ["20261001_o0"]);

  assert.deepEqual((await client.request("listSessions", { independent: true, workspace: alpha })).sessions, [], "team member folder returns no independent sessions");
  const folder = await client.request("listSessions", { independent: true, workspace: beta });
  assert.deepEqual(folder.sessions.map(s => s.runtimeSessionId), ["20261001_b4", "20261001_b3", "20261001_b2", "20261001_b1", "20261001_b0"]);

  // Repeated overview loads stay cheap: one index scan for every folder, not one per folder.
  const times = [];
  for (let i = 0; i < 5; i++) { const at = Date.now(); await client.request("listSessions", { independent: true }); times.push(Date.now() - at); }
  assert.ok(Math.max(...times) < 1500, `overview loads stay cheap: ${times.join(", ")} ms (first ${elapsed} ms)`);

  // Exercise paging through management IPC and the actual Python index, rather
  // than a mock that already understands the exclusion protocol.
  index.sessions.push(...Array.from({ length: 200 }, (_, i) => entry(`older_${i}`, beta, "2025-01-01T00:00:00Z")));
  await writeFile(path.join(home, "session_index.json"), JSON.stringify(index));
  const loaded = [];
  const sizes = [];
  for (let page = 0; page < 3; page++) {
    const result = await client.request("listSessions", { independent: true, workspace: beta, excludeSessionIds: loaded.map(s => s.runtimeSessionId) });
    sizes.push(result.sessions.length); loaded.push(...result.sessions);
  }
  assert.deepEqual(sizes, [100, 100, 5]);
  assert.equal(new Set(loaded.map(s => s.runtimeSessionId)).size, 205);
  await assert.rejects(client.request("listSessions", { independent: true, workspace: beta, excludeSessionIds: [1] }), { code: "INVALID_INPUT" });
});
