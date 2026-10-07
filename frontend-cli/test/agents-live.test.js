import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
import { backgroundRows, independentSessions } from "../lib/agents-model.js";
import { runAgentsPage } from "../lib/agents-page.js";
import { sessionWorkspace } from "../lib/agents-session.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";

// One Rind window runs a turn in a folder that belongs to no team. Another
// window's Agents page must see it running, then open and finally idle.
test("a plain window's turn is visible to management while it runs, and its presence after", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-live-"));
  const folder = path.join(home, "notes"); await mkdir(folder);
  const held = [];
  const provider = http.createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    request.resume(); request.on("end", () => held.push(response));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:" + provider.address().port + "/v1" }));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const server = await startServer({ home, repoRoot });
  const window = createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder], onMessage() {} });
  let client;
  t.after(async () => {
    held.forEach(response => response.destroy()); client?.close(); await window.shutdown(); await server.close();
    await new Promise(resolve => provider.close(resolve)); await removeRindHome(home);
  });
  await window.request("initialize");
  const info = await window.request("session/create", {});
  // A new conversation has no saved history yet; the Runtime still knows its folder,
  // so another window can open it instead of failing on missing metadata.
  assert.equal(path.resolve(await sessionWorkspace(home, info.session_id)).toLowerCase(), path.resolve(folder).toLowerCase());
  assert.equal(await sessionWorkspace(home, "20990101_unknown"), "");
  // The Agents page subscribes; management then attaches to the window's Runtime by itself.
  let latest;
  client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim(), onSnapshot: snapshot => { latest = snapshot; } });
  latest = await client.request("subscribe", {});
  const until = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (latest && check(latest)) return latest; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail(label + "\n" + JSON.stringify(latest?.live));
  };
  const mine = snapshot => (snapshot.live || []).find(item => item.id === info.session_id);
  await until(snapshot => mine(snapshot)?.watchers === 1, "the open window is reported");
  const prompt = window.request("session/prompt", { session_id: info.session_id, input: "hello" }).catch(() => {});
  const running = await until(snapshot => mine(snapshot)?.turn === "running", "the running turn is reported");
  const rows = backgroundRows(running, null);
  assert.deepEqual(rows.filter(r => r.kind === "live").map(r => [r.status, r.context]), [["Working", "notes"]], "RUNNING NOW lists the plain window's turn");
  assert.equal(independentSessions(running, [], "").find(g => g.name === "notes").sessions[0].status, "Working");
  assert.equal(running.agents.length, 0, "a plain session never becomes an agent");

  // Enter on it in Background › Running now opens it in its folder, as Independent does.
  const input = createVirtualInput(), output = createVirtualOutput({ columns: 120, rows: 30 });
  const opened = [], abort = new AbortController();
  const page = runAgentsPage({ launch: { home, repoRoot }, input, output: output.output, signal: abort.signal, openChat: async chat => { opened.push(chat); return { action: "return" }; } });
  const shows = async text => { for (let i = 0; i < 200; i++) { if ((await output.flushAndGetViewport()).join("\n").includes(text)) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail("Expected " + text + "\n" + output.getViewport().join("\n")); };
  await shows("Inbox");
  input.send("jjj"); await shows("what keeps running after you leave Rind");
  input.send("\r"); await shows("RUNNING NOW · 1");
  input.send("g"); input.send("\r");
  for (let i = 0; i < 300 && !opened.length; i++) await new Promise(resolve => setTimeout(resolve, 40));
  abort.abort(); await page;
  assert.equal(opened.length, 1, "the running conversation opens instead of failing");
  assert.equal(opened[0].runtimeSessionId, info.session_id);
  assert.equal(path.resolve(opened[0].agent.canonicalWorkspace).toLowerCase(), path.resolve(folder).toLowerCase());
  assert.equal(opened[0].teamId, undefined);
  // Leaving while the turn runs: the window closes, the turn goes on, and the
  // conversation must not stay "open" once its request finishes later.
  await window.shutdown();
  await until(snapshot => mine(snapshot)?.watchers === 0 && mine(snapshot)?.turn === "running", "the turn keeps running with nobody watching");
  held.forEach(response => response.destroy());
  await prompt;
  const admin = createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder, "--session", info.session_id], onMessage() {} });
  await admin.request("initialize");
  await admin.request("session/cancel", { session_id: info.session_id }).catch(() => {});
  await admin.shutdown();
  const done = await until(snapshot => mine(snapshot)?.turn === "idle" && mine(snapshot)?.watchers === 0, "the finished turn is idle with no stale watcher");
  assert.equal(backgroundRows(done, null).filter(r => r.kind === "live").length, 0);
});
