import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { createSharedRuntimeClient } from "../../rind-runtime-client/shared-runtime.js";
import { runAgentsPage } from "../lib/agents-page.js";
import { harness } from "./helpers/agents-harness.js";
import { removeRindHome } from "./helpers/rind-home.js";

// Open means on screen. A window covered by the Agents page holds its
// conversation but no longer counts, and counts again when it is back.
test("a window covered by Agents stops making its conversation Open", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-visible-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const folder = path.join(home, "notes"); await mkdir(folder);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1" }));
  const server = await startServer({ home, repoRoot });
  const window = createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder], onMessage() {} });
  const other = createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder], onMessage() {} });
  let client, latest;
  t.after(async () => { client?.close(); await window.shutdown(); await other.shutdown(); await server.close(); await removeRindHome(home); });
  const mine = (await window.request("initialize")).session_id;
  const theirs = (await other.request("initialize")).session_id;
  client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim(), onSnapshot: snapshot => { latest = snapshot; } });
  latest = await client.request("subscribe", {});
  const watchers = () => Object.fromEntries((latest.live || []).map(item => [item.id, item.watchers]));
  const until = async (expected, label) => {
    for (let i = 0; i < 200; i++) { if (watchers()[mine] === expected[0] && watchers()[theirs] === expected[1]) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail(label + " " + JSON.stringify(watchers()));
  };
  await until([1, 1], "both windows show their conversation");
  await window.setVisible(false);
  await until([0, 1], "the covered window's conversation is no longer Open; another terminal's still is");
  await window.setVisible(true);
  await until([1, 1], "back on screen, it is Open again");
});

async function teamWithConversations(h, ids) {
  const team = await h.client.request("createTeam", { name: "Product" });
  const lead = await h.client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  for (const id of ids) {
    const session = await h.client.request("attachSession", { agentId: lead.id, teamId: team.id });
    await h.client.request("bindSession", { sessionId: session.id, runtimeSessionId: id });
    // Saved conversations: going back to one reopens it rather than starting anew.
    await mkdir(path.join(h.home, "sessions", id), { recursive: true });
    await writeFile(path.join(h.home, "sessions", id, "meta.json"), JSON.stringify({ workspace_root: lead.canonicalWorkspace }));
  }
  return { team, lead };
}
function selectedLine(screen) { return screen.split("\n").find(line => /│› /.test(line)) || ""; }
async function select(h, text) {
  for (let i = 0; i < 12; i++) {
    if (selectedLine(await h.visible(text)).includes(text)) return;
    h.key("j"); await h.settle();
  }
  assert.fail("Could not select " + text + "\n" + h.screen());
}

test("windows never stack: Esc goes back to the conversation just left, and ctrl+c only leaves", { timeout: 40000 }, async t => {
  const h = await harness({ prefix: "rind-agents-flat-" });
  const { team } = await teamWithConversations(h, ["20261007_second", "20261007_third"]);
  const opened = [];
  const steps = [];
  const abort = new AbortController();
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, initialTeamId: team.id, currentSessionId: "20261007_own",
    openChat: async chat => { opened.push(chat.runtimeSessionId); return steps.shift() || { action: "agents", from: { runtimeSessionId: chat.runtimeSessionId } }; } });
  t.after(async () => { abort.abort(); await running; await h.cleanup(); });
  const { key, visible, settle } = h;

  await visible("20261007_second"); await visible("20261007_third");
  await select(h, "20261007_second"); key("\r");
  await visible("↩ 20261007_second");
  assert.ok(selectedLine(h.screen()).includes("20261007_second"), "the conversation just left stays selected");

  key("\x1b"); await visible("esc back to conversation");
  key("\x1b"); await settle();
  assert.deepEqual(opened, ["20261007_second", "20261007_second"], "Esc reopens the conversation just left");

  await select(h, "20261007_third"); key("\r");
  await visible("↩ 20261007_third");
  assert.doesNotMatch(h.screen(), /↩ 20261007_second/, "only one conversation is the way back; the other is simply in the background");

  steps.push({ action: "leave" });
  key("\x1b"); await visible("esc back to conversation"); key("\x1b");
  const result = await Promise.race([running, new Promise(resolve => setTimeout(() => resolve("timeout"), 5000))]);
  assert.deepEqual(opened, ["20261007_second", "20261007_second", "20261007_third", "20261007_third"]);
  assert.equal(result.leave, true, "leaving from any conversation closes everything at once");
});

test("Esc from Agents returns to this window's own conversation without reopening it", { timeout: 30000 }, async t => {
  const h = await harness({ prefix: "rind-agents-own-" });
  const { team } = await teamWithConversations(h, ["20261007_own"]);
  const opened = [];
  const abort = new AbortController();
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, initialTeamId: team.id, currentSessionId: "20261007_own",
    openChat: async chat => { opened.push(chat.runtimeSessionId); return { action: "return" }; } });
  t.after(async () => { abort.abort(); await running; await h.cleanup(); });
  await h.visible("↩ 20261007_own");
  // Choosing it is the same as going back: this window still has it loaded.
  await select(h, "20261007_own"); h.key("\r");
  const result = await Promise.race([running, new Promise(resolve => setTimeout(() => resolve("timeout"), 5000))]);
  assert.equal(result.leave, false);
  assert.deepEqual(opened, [], "no second window for a conversation this one holds");
});

// Screenshot-free regression of "the new session is still listed": the push
// that follows a conversation closing arrives before the way back moves on, so
// drafts must be filtered against the current way back, not the one at push time.
test("an empty conversation disappears from the list once another conversation becomes the way back", { timeout: 60000 }, async t => {
  const h = await harness({ prefix: "rind-agents-draft-" });
  const repoRoot = h.launch.repoRoot;
  const folder = path.join(h.home, "notes"); await mkdir(folder);
  await writeFile(path.join(h.home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1" }));
  const window = createSharedRuntimeClient({ rindHome: h.home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder], onMessage() {} });
  const draft = (await window.request("initialize")).session_id;
  const { team } = await teamWithConversations(h, ["20261007_member"]);
  const abort = new AbortController();
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, currentSessionId: draft,
    openChat: async chat => ({ action: "agents", chat, from: { runtimeSessionId: chat.runtimeSessionId } }) });
  t.after(async () => { abort.abort(); await running; await window.shutdown(); await h.cleanup(); });
  const { key, visible, settle } = h;

  const fresh = async () => (await h.output.flushAndGetViewport()).join("\n");
  // Moves the sidebar selection to `name` (Inbox, Manager, Independent, Background, Product).
  const sidebar = async name => {
    for (let i = 0; i < 10 && !(await fresh()).split("\n").some(line => line.startsWith("›") && line.includes(name)); i++) { key(i < 5 ? "k" : "j"); await settle(); }
  };
  // Left climbs one level per press until the sidebar has focus (it shows the leave hint).
  // Esc there would go back to the conversation instead.
  const toSidebar = async () => { for (let i = 0; i < 4 && !(await fresh()).includes("ctrl+c ×2 leave Rind"); i++) { key("\x1b[D"); await settle(); } };
  await visible("Independent");
  await sidebar("Independent"); key("\r");
  await visible("↩ New conversation");
  await toSidebar(); await sidebar("Product"); key("\r"); await visible("20261007_member");
  await select(h, "20261007_member"); key("\r");
  await visible("↩ 20261007_member");
  await toSidebar(); await sidebar("Independent"); key("\r"); await settle(); await settle();
  assert.doesNotMatch(h.screen(), /New conversation/, "the empty conversation is no longer the way back, so it is not listed");
  assert.equal(team.name, "Product");
});

// Nothing keeps a conversation that never got a message once no window holds
// it: not the Runtime's table, not the worker. A saved one is kept.
test("the Runtime forgets an empty conversation when its last window lets go of it", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-forget-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const folder = path.join(home, "notes"); await mkdir(folder);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1" }));
  const open = (args = []) => createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder, ...args], onMessage() {} });
  const first = open(), second = open(), probe = open();
  t.after(async () => { await first.shutdown(); await second.shutdown(); await probe.shutdown(); await removeRindHome(home); });
  const draft = (await first.request("initialize")).session_id;
  await probe.request("initialize");
  const table = async () => (await probe.request("runtime/sessions")).sessions;
  const until = async (check, label) => {
    for (let i = 0; i < 100; i++) { if (check(await table())) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail(label + " " + JSON.stringify(await table()));
  };
  await until(list => list.some(item => item.id === draft && item.draft), "the empty conversation is a draft");

  // Another window holding it keeps it alive.
  await second.request("initialize");
  await second.request("session/subscribe", { session_id: draft });
  await first.request("session/unsubscribe", { session_id: draft });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok((await table()).some(item => item.id === draft), "still held by the second window");

  await second.request("session/unsubscribe", { session_id: draft });
  await until(list => !list.some(item => item.id === draft), "forgotten once nobody holds it");
  await assert.rejects(probe.request("session/subscribe", { session_id: draft }), /not found|SessionNotFound|No session/i, "the worker no longer knows it");

  // Closing the window that has a draft open forgets it the same way.
  const closing = open();
  const other = (await closing.request("initialize")).session_id;
  await until(list => list.some(item => item.id === other), "the second draft is listed");
  await closing.shutdown();
  await until(list => !list.some(item => item.id === other), "a closed window's draft is forgotten");
  // A saved conversation is never forgotten: see test_runtime_forget_draft.py.
});

test("going back to an empty conversation that was forgotten starts a new one in the same place", { timeout: 30000 }, async t => {
  const h = await harness({ prefix: "rind-agents-gone-" });
  const { team, lead } = await teamWithConversations(h, ["20261007_saved"]);
  const opened = [];
  const abort = new AbortController();
  // The child window ends on a draft that no longer exists anywhere.
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, initialTeamId: team.id,
    openChat: async chat => { opened.push(chat); return { action: "agents", chat, from: { runtimeSessionId: "20261007_000000_deadbeef", workspace: lead.canonicalWorkspace } }; } });
  t.after(async () => { abort.abort(); await running; await h.cleanup(); });
  await select(h, "20261007_saved"); h.key("\r");
  for (let i = 0; i < 100 && opened.length < 1; i++) await h.settle();
  for (let i = 0; i < 4 && !(await h.output.flushAndGetViewport()).join("\n").includes("esc back to conversation"); i++) { h.key("\x1b[D"); await h.settle(); }
  h.key("\x1b");
  for (let i = 0; i < 100 && opened.length < 2; i++) await h.settle();
  assert.equal(opened.length, 2);
  assert.equal(opened[1].runtimeSessionId, undefined, "a new conversation, not a missing one");
  assert.equal(opened[1].teamId, team.id);
  assert.equal(opened[1].agent.id, lead.id, "in the same member's folder");
});
