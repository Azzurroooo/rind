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
  const service = createService({ store, paths, adapters: { rind: adapter }, toolConfig: () => ({}) });
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
  return { home, paths, store, service, call, team, leader, member, starts };
}
export async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), "state did not converge");
}
