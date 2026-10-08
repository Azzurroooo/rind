import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { runAgentsPage } from "../lib/agents-page.js";
import { managementArgs } from "../lib/agents-session.js";
import { createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";
import { harness, waitFor } from "./helpers/agents-harness.js";
import { createTui } from "../lib/tui/tui.js";

test("manager keeps its dedicated workspace and rejects mixed session scopes", () => {
  assert.throws(() => managementArgs(["--manager", "--cwd", "private"]), /dedicated workspace/);
  assert.throws(() => managementArgs(["--team", "A", "--standalone"]), /Choose one/);
  assert.deepEqual(managementArgs(["--manager", "--session", "history", "--prefill", "draft"]).args, ["--session", "history"]);
});

test("real CLI empty-prompt entry returns to an editable conversation repeatedly", { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-entry-"));
  const workspace = path.join(home, "workspace");
  await mkdir(path.join(workspace, ".rind"), { recursive: true });
  await writeFile(path.join(workspace, ".rind", "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture-model", baseUrl: "http://127.0.0.1:1/v1" }));
  const server = await startServer({ home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) });
  const script = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
    process.stdout.columns = 100; process.stdout.rows = 26;
    const { runFrontendCliApp } = await import(${JSON.stringify(new URL("../lib/frontend-cli-implementation.js", import.meta.url).href)});
    await runFrontendCliApp(['--cwd', ${JSON.stringify(workspace)}, '--standalone']);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: workspace, env: { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const output = createVirtualOutput({ columns: 100, rows: 26 });
  child.stdout.on("data", value => output.output.write(value));
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; await server.close(); await removeRindHome(home); });
  async function visible(text) {
    for (let i = 0; i < 600; i++) {
      const screen = (await output.flushAndGetViewport()).join("\n");
      if (screen.includes(text)) return screen;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail("Expected " + text + "\n" + output.getViewport().join("\n") + "\n" + errors);
  }
  await visible("← agents");
  for (let i = 0; i < 2; i++) {
    child.stdin.write("\x1b[D"); await visible("New team");
    child.stdin.write("\x1b"); await visible("← agents");
  }
  child.stdin.write("retained draft"); await visible("retained draft");
  child.stdin.write("\x1b[D"); await new Promise(resolve => setTimeout(resolve, 80));
  assert.doesNotMatch(output.getViewport().join("\n"), /New team/);
  child.stdin.write("\x05\x15/exit\r");
  assert.equal(await exited, 0, errors);
});

test("team page edits members, nests team conversations and drives tasks from the keyboard", { timeout: 40000 }, async t => {
  const h = await harness({ prefix: "rind-agents-actions-" });
  const team = await h.client.request("createTeam", { name: "Product" });
  const lead = await h.client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  await h.client.request("setLeader", { teamId: team.id, agentId: lead.id });
  const task = await h.client.request("assignTask", { teamId: team.id, assigneeAgentId: lead.id, brief: "Review release", start: false });
  const scoped = await h.client.request("attachSession", { agentId: lead.id, teamId: team.id });
  await h.client.request("bindSession", { sessionId: scoped.id, runtimeSessionId: "20261005_team_history" });
  const independent = await h.client.request("attachSession", { agentId: lead.id });
  await h.client.request("bindSession", { sessionId: independent.id, runtimeSessionId: "20261005_private_history" });
  const chats = [], abort = new AbortController();
  const main = createTui({ input: h.input, output: h.output.output });
  main.addChild({ render: () => ["Original conversation", "Draft preserved"] }); main.start();
  await new Promise(resolve => setTimeout(resolve, 40)); main.stop({ releaseInput: false });
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, initialTeamId: team.id, manageInput: false, signal: abort.signal, openChat: async context => { chats.push(context); } });
  t.after(async () => { abort.abort(); await running; main.stop(); await h.cleanup(); });
  const { key, paste, visible, settle } = h;

  await visible("Leader"); await visible("Lead ");
  await visible("20261005_team_history");
  assert.doesNotMatch(h.screen(), /20261005_private_history/, "independent conversations never appear in a team");

  // Left climbs one level at a time and never folds the tree on the way.
  key("j"); await visible("enter join");
  key("\x1b[D"); await visible("enter open member");
  key("\x1b[D"); await visible("back to chat");
  assert.match(h.screen(), /20261005_team_history/, "leaving the tree keeps it expanded");
  key("\r"); await visible("enter open member");
  key("z"); await visible("▸ Lead");
  assert.doesNotMatch(h.screen(), /20261005_team_history/);
  key("z"); await visible("20261005_team_history");

  key("e"); await visible("Role and responsibility");
  paste("Coordinator"); key("\r"); paste("Integrate release evidence"); key("\r");
  await visible("Integrate release evidence"); await visible("Updated Lead");
  assert.equal((await h.client.request("snapshot")).memberships[0].position, "Coordinator");

  key("a"); await visible("Existing folder"); await visible("Reports to Lead"); key("\r"); await visible("Tab completes folder names");
  paste(path.join(h.home, "missing")); key("\r");
  await visible("No folder at"); assert.match(h.screen(), /missing/, "an invalid folder keeps what was typed and stays on the field");
  key("\x1b"); await settle();

  await h.client.request("createWorkspace", { teamId: team.id, name: "Reviewer" });
  await visible("Reviewer");

  key("\r"); await visible("conversations in this team"); await visible("New conversation");
  assert.doesNotMatch(h.screen(), /20261005_private_history/);
  key("g"); key("\r");
  await waitFor(() => chats.length === 1, "new conversation");
  assert.equal(chats[0].agent.id, lead.id);
  assert.equal(chats[0].teamId, team.id);
  await visible("20261005_team_history"); key("j"); key("\r");
  await waitFor(() => chats.length === 2, "joined conversation");
  assert.equal(chats[1].runtimeSessionId, "20261005_team_history");
  assert.equal(chats[1].agent.canonicalWorkspace, lead.canonicalWorkspace);
  assert.equal(chats[1].teamId, team.id);

  key("\x1b"); await visible("Leader · Coordinator");
  key(" "); await visible("Add member below"); key("c");
  await waitFor(() => chats.length === 3, "conversation from the member menu");
  assert.equal(chats[2].agent.id, lead.id);
  assert.equal(chats[2].teamId, team.id);
  await visible("Leader · Coordinator");
  key("2"); await visible("QUEUED · 1"); await visible("Review release");
  key(" "); await visible("Queue priority"); key("p"); await visible("Running work is never interrupted"); key("1");
  await visible("Priority set to high");
  assert.equal((await h.client.request("getTask", { taskId: task.id })).priority, "high");
  key("\r"); await visible("No report yet");
  key(" "); await visible("Add note"); key("n"); await visible("Shared with the task owner");
  paste("Check the changelog"); key("\r"); await visible("Note added"); await visible("Notes 3");
  key("z"); await visible("Check the changelog");
  key("\x1b"); await visible("QUEUED · 1");
  key(" "); await visible("Cancel task"); key("x"); await visible("Cancel this task?"); key("y");
  await visible("CANCELLED · 1");
  assert.equal((await h.client.request("getTask", { taskId: task.id })).status, "cancelled");

  key("\x1b"); await settle(); key("g"); key("j"); await visible("conversations that coordinate every team"); key("\r"); key("\r");
  await waitFor(() => chats.length === 4, "manager conversation");
  assert.equal(chats[3].manager, true);
  const managerSession = await h.client.request("attachSession", { manager: true });
  await h.client.request("bindSession", { sessionId: managerSession.id, runtimeSessionId: "20261005_manager_history" });
  key("r"); await visible("20261005_manager_history");
  key("/"); paste("manager_history"); key("\r"); key("j"); key("\r");
  await waitFor(() => chats.length === 5, "manager history");
  assert.equal(chats[4].manager, true, "Manager history keeps its restricted identity");
  assert.equal(chats[4].runtimeSessionId, "20261005_manager_history");
  assert.equal(chats[4].teamId, undefined);

  // Independent lists conversations outside every team, grouped by folder.
  await visible("Manager ·"); await settle();
  key("\x1b"); await settle(); assert.doesNotMatch(h.screen(), /esc clears/, "the first esc clears the search");
  key("\x1b"); await settle(); key("j"); await visible("conversations outside any team, by folder");
  await visible("20261005_private_history");
  assert.doesNotMatch(h.screen(), /20261005_team_history/, "team conversations stay on their team");
  key("\r"); key("j"); await visible("enter join"); key("\r");
  await waitFor(() => chats.length === 6, "independent conversation");
  assert.equal(chats[5].runtimeSessionId, "20261005_private_history");
  assert.equal(chats[5].teamId, undefined);
  assert.equal(chats[5].agent.canonicalWorkspace, lead.canonicalWorkspace);

  abort.abort(); await running;
  assert.equal(h.input.listenerCount("data"), 0);
  assert.equal(h.input.isRaw, true);
  main.start({ acquireInput: false }); main.replayAll(); await visible("Original conversation");
  assert.doesNotMatch(h.screen(), /Leader · Coordinator|Organization/);
});

test("a new team flows straight into adding its first member, who becomes the leader", { timeout: 20000 }, async t => {
  const h = await harness({ columns: 100, rows: 24, prefix: "rind-agents-page-" });
  const workspace = path.join(h.home, "finance"); await mkdir(workspace);
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output });
  t.after(async () => { h.input.send("\x03"); await running; await h.cleanup(); });
  const { key, paste, visible } = h;
  await visible("New team"); await visible("Create your first team");
  key("n"); await visible("Team name"); paste("Accounts"); key("\r");
  await visible("Existing folder"); await visible("The first member becomes the team leader"); key("\r");
  await visible("Tab completes folder names"); paste(workspace); await visible("✓"); key("\r");
  await visible("Defaults to the folder name"); key("\r");
  await visible("A short job title"); paste("Finance"); key("\r");
  await visible("It is added to the"); paste("Reconcile invoices"); key("\r");
  await visible("is the team leader");
  const view = await h.client.request("snapshot");
  assert.equal(view.teams[0].leaderAgentId, view.agents[0].id);
  assert.equal(view.memberships[0].responsibility, "Reconcile invoices");
  await visible("Leader"); await visible("finance ");
  key("?"); await visible("Keyboard"); key("?");
  for (const width of [40, 80, 120]) {
    h.output.resize(width, 20); await visible("Agents");
    assert.ok(h.output.getViewport().every(line => line.length <= width));
  }
  key("\x1b"); await h.settle(); await visible("back to chat"); key("\x1b"); await running;
  assert.equal(h.input.isRaw, false);
});

test("refreshing says so even when nothing changed, and a duplicate team name is refused in the form", { timeout: 20000 }, async t => {
  const h = await harness({ columns: 100, rows: 24, prefix: "rind-agents-refresh-" });
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output });
  // A dialog stays open at the end, so ctrl+c twice: the first only arms leaving.
  t.after(async () => { h.input.send("\x03"); h.input.send("\x03"); await running; await h.cleanup(); });
  const { key, paste, visible } = h;
  await visible("Create your first team");
  key("r"); await visible("Up to date");
  key("n"); await visible("Team name"); paste("Notes"); key("\r"); await visible("Existing folder");
  // Esc and the next key sent together read as alt+key; let Esc land first.
  key("\x1b"); await h.settle();
  key("n"); await visible("Team name"); paste("notes"); key("\r");
  await visible("already exists");
  assert.equal((await h.client.request("snapshot")).teams.length, 1);
});
