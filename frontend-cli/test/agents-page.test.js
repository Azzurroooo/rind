import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { runAgentsPage } from "../lib/agents-page.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";

test("agents page assembles arbitrary folders, chooses the first leader and preserves return controls", { timeout: 15000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-page-"));
  const workspace = path.join(home, "finance"); await mkdir(workspace);
  const launch = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(launch);
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  const input = createVirtualInput(), output = createVirtualOutput();
  const running = runAgentsPage({ launch, input, output: output.output });
  t.after(async () => { input.send("\x03"); await running; client.close(); await server.close(); await rm(home, { recursive: true, force: true }); });
  async function visible(text) {
    t.diagnostic("Waiting for " + text);
    for (let i = 0; i < 100; i++) {
      const viewport = (await output.flushAndGetViewport()).join("\n");
      if (viewport.includes(text)) return viewport;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Expected screen: " + text + "\n" + output.getViewport().join("\n"));
  }
  const paste = text => input.send("\x1b[200~" + text + "\x1b[201~");
  await visible("No teams yet"); input.send("n"); await visible("Team name");
  paste("Accounts"); input.send("\r"); await visible("No members yet");
  input.send("a"); await visible("Workspace path"); paste(workspace); input.send("\r");
  paste("Finance"); input.send("\r"); paste("Reconcile invoices"); input.send("\r");
  await visible("Member added");
  const view = await client.request("snapshot");
  assert.equal(view.teams[0].leaderAgentId, view.agents[0].id);
  assert.equal(view.memberships[0].responsibility, "Reconcile invoices");
  for (const width of [40, 80, 120]) {
    output.resize(width, 20); await visible("Agents Management");
    assert.ok(output.getViewport().every(line => line.length <= width));
  }
  input.send("\x1b"); await visible("folders can be anywhere"); input.send("q"); await running;
  assert.equal(input.isRaw, false);
});
