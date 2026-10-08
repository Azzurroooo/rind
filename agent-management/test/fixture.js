import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../dist/service.js";
import { openStore } from "../dist/store.js";
import { managementPaths } from "../dist/paths.js";

export const user = { kind: "user" };
export async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-management-"));
  const paths = managementPaths(home);
  const store = await openStore(paths.state, 5);
  const starts = [];
  const adapter = { async start(input) {
    let finish, fail;
    const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    starts.push({ input, finish, fail });
    return { runtimeSessionId: randomUUID(), completion, async cancel() { finish({ content: "" }); } };
  } };
  // Stands in for the Rind runtime's folder defaults: records each call, keeps the last value per folder.
  const folders = new Map(), folderCalls = [];
  const folderDefaults = async (method, params = {}) => {
    folderCalls.push([method, params]);
    if (method === "models") return [{ provider_id: "deepseek", id: "deepseek-flash", reasoning_efforts: ["low", "high"] }];
    if (method === "set" && params.model_id === "missing") throw new Error(params.provider_id + " / missing is not available.");
    if (method === "set") folders.set(params.workspace_root, { ...folders.get(params.workspace_root), ...params });
    if (method === "unset") folders.delete(params.workspace_root);
    if (method === "resolve") return { folders: Object.fromEntries(params.workspace_roots.map(root => [root, { model: folders.get(root)?.model_id || "settings-model" }])) };
    return { workspace_root: params.workspace_root, folder: folders.get(params.workspace_root) || {} };
  };
  const service = createService({ store, paths, adapters: { rind: adapter }, toolConfig: () => ({}), folderDefaults });
  t.after(async () => { await service.stop(); await rm(home, { recursive: true, force: true }); });
  const call = (method, params = {}, actor = user) => service.request(actor, method, { requestId: randomUUID(), ...params });
  const team = await call("createTeam", { name: "Product" });
  async function member(name, workspace) {
    workspace ||= path.join(home, name);
    await mkdir(workspace, { recursive: true });
    const agent = await call("registerAgent", { workspace, name });
    await call("addMember", { teamId: team.id, agentId: agent.id });
    return agent;
  }
  const leader = await member("leader");
  await call("setLeader", { teamId: team.id, agentId: leader.id });
  return { home, paths, store, service, call, team, leader, member, starts, folderCalls };
}
export async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), "state did not converge");
}
