import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../../agent-management/dist/ipc.js";
import { connectClient } from "../../../agent-management/dist/client.js";
import { createVirtualInput, createVirtualOutput } from "./virtual-terminal.js";
import { removeRindHome } from "./rind-home.js";

// A real management service in a temporary home, a client, and a virtual
// terminal for driving the Agents page from the keyboard.
export async function harness({ columns = 120, rows = 30, prefix }) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const launch = { home, repoRoot: fileURLToPath(new URL("../../..", import.meta.url)) };
  const server = await startServer(launch);
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  const input = createVirtualInput(), output = createVirtualOutput({ columns, rows });
  const screen = () => output.getViewport().join("\n");
  const visible = async text => {
    for (let i = 0; i < 250; i++) {
      const viewport = (await output.flushAndGetViewport()).join("\n");
      if (viewport.includes(text)) return viewport;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Expected " + text + "\n" + screen());
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  const cleanup = async () => {
    client.close(); await server.close();
    await removeRindHome(home);
  };
  return { home, launch, client, input, output, screen, visible, settle, cleanup, key: sequence => input.send(sequence), paste: text => input.send("\x1b[200~" + text + "\x1b[201~") };
}
export async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail("Timed out waiting for " + label);
}

