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
  // Each window has sent its first message, so each shows a conversation.
  await window.request("initialize"); await other.request("initialize");
  const mine = (await window.request("session/create", {})).session_id;
  const theirs = (await other.request("session/create", {})).session_id;
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

// A window is only a folder and an input box until its first message: the
// Runtime lists nothing for it, and the message creates the conversation.
test("a window before its first message is listed nowhere; the message creates its conversation", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-first-message-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const folder = path.join(home, "notes"); await mkdir(folder);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1" }));
  const open = () => createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder], onMessage() {} });
  const window = open(), probe = open();
  t.after(async () => { await window.shutdown(); await probe.shutdown(); await removeRindHome(home); });
  const info = await window.request("initialize");
  assert.equal(info.session_id, "");
  assert.ok(info.model && info.workspace_root, "it still knows its folder and settings");
  await probe.request("initialize");
  const table = async () => (await probe.request("runtime/sessions")).sessions;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await table(), [], "nothing exists to list");
  const created = await window.request("session/create", { model_id: "chosen" });
  assert.equal(created.model, "chosen", "the settings chosen before the message are kept");
  for (let i = 0; i < 100 && !(await table()).some(item => item.id === created.session_id); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual((await table()).map(item => [item.id, item.watchers]), [[created.session_id, 1]]);
  assert.equal("draft" in (await table())[0], false);
  await window.shutdown();
});

test("going back to a window left before its first message starts a new conversation there", { timeout: 30000 }, async t => {
  const h = await harness({ prefix: "rind-agents-gone-" });
  const { team, lead } = await teamWithConversations(h, ["20261007_saved"]);
  const opened = [];
  const abort = new AbortController();
  // The child window was left before its first message: it has no conversation.
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, initialTeamId: team.id,
    openChat: async chat => { opened.push(chat); return { action: "agents", chat, from: { runtimeSessionId: "", workspace: lead.canonicalWorkspace } }; } });
  t.after(async () => { abort.abort(); await running; await h.cleanup(); });
  await select(h, "20261007_saved"); h.key("\r");
  for (let i = 0; i < 100 && opened.length < 1; i++) await h.settle();
  for (let i = 0; i < 4 && !(await h.output.flushAndGetViewport()).join("\n").includes("esc back to conversation"); i++) { h.key("\x1b[D"); await h.settle(); }
  h.key("\x1b");
  for (let i = 0; i < 100 && opened.length < 2; i++) await h.settle();
  assert.equal(opened.length, 2);
  assert.equal(opened[1].runtimeSessionId, undefined, "a new conversation, since none was created");
  assert.equal(opened[1].teamId, team.id);
  assert.equal(opened[1].agent.id, lead.id, "in the same member's folder");
});

// One write path for names: a window's /rename and the Agents page's Rename…
// both run the conversation's own command; every list follows at once.
test("a conversation renamed anywhere is shown by its name everywhere", { timeout: 60000 }, async t => {
  const { renameConversation } = await import("../lib/agents-session.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-rename-"));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const folder = path.join(home, "notes"); await mkdir(folder);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1" }));
  const open = () => createSharedRuntimeClient({ rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot, cliArgs: ["--cwd", folder], onMessage() {} });
  const window = open(), probe = open();
  t.after(async () => { await window.shutdown(); await probe.shutdown(); await removeRindHome(home); });
  await window.request("initialize"); await probe.request("initialize");
  const { session_id: id } = await window.request("session/create", { name: "Planning" });
  const live = async () => (await probe.request("runtime/sessions")).sessions.find(item => item.id === id);

  const renamed = await window.request("rind/command/execute", { session_id: id, input: "/rename Release checks" });
  assert.equal(renamed.display.title, "Release checks");
  for (let i = 0; i < 100 && (await live())?.title !== "Release checks"; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await live())?.title, "Release checks", "the live table carries the new title to every list");

  const reset = await renameConversation({ home, repoRoot, python: process.env.RIND_PYTHON || "python" }, id, "");
  assert.deepEqual([reset.name, reset.title], [null, ""], "no first message yet, so nothing to show but its id");
  await assert.rejects(renameConversation({ home, repoRoot, python: process.env.RIND_PYTHON || "python" }, "20261007_000000_deadbeef", "x"), /not|Session/i);
});
