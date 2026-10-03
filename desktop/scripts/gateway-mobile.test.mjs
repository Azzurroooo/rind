import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { DesktopGateway } from "../src/main/gateway/server.ts";

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
