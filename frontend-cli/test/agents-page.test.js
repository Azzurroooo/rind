import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { runAgentsPage } from "../lib/agents-page.js";
import { managementArgs } from "../lib/agents-session.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
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
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; await server.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
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
    child.stdin.write("\x1b[D"); await visible("+ Create team");
    child.stdin.write("\x1b"); await visible("← agents");
  }
  child.stdin.write("retained draft"); await visible("retained draft");
  child.stdin.write("\x1b[D"); await new Promise(resolve => setTimeout(resolve, 80));
  assert.doesNotMatch(output.getViewport().join("\n"), /Create team/);
  child.stdin.write("\x05\x15/exit\r");
  assert.equal(await exited, 0, errors);
});

test("page actions retain failed edits, selection across updates, task controls and Manager return", { timeout: 20000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-actions-"));
  const launch = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(launch);
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  const team = await client.request("createTeam", { name: "Product" });
  const lead = await client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  await client.request("setLeader", { teamId: team.id, agentId: lead.id });
  const task = await client.request("assignTask", { teamId: team.id, assigneeAgentId: lead.id, brief: "Review release", start: false });
  const input = createVirtualInput(), output = createVirtualOutput({ columns: 120, rows: 30 });
  const chats = [], abort = new AbortController();
  const main = createTui({ input, output: output.output });
  main.addChild({ render: () => ["Original conversation", "Draft preserved"] }); main.start();
  await new Promise(resolve => setTimeout(resolve, 40)); main.stop({ releaseInput: false });
  const running = runAgentsPage({ launch, input, output: output.output, initialTeamId: team.id, manageInput: false, signal: abort.signal, openChat: async context => { chats.push(context); } });
  t.after(async () => { abort.abort(); await running; main.stop(); client.close(); await server.close();
    const host = await connectSharedRuntime({ home, start: false }).catch(() => null);
    if (host) { await host.request("runtime/shutdown").catch(() => {}); host.close(); await new Promise(resolve => setTimeout(resolve, 300)); }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const visible = async text => {
    for (let i = 0; i < 150; i++) {
      const screen = (await output.flushAndGetViewport()).join("\n");
      if (screen.includes(text)) return screen;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Expected " + text + "\n" + output.getViewport().join("\n"));
  };
  const key = sequence => input.send(sequence);
  const paste = text => key("\x1b[200~" + text + "\x1b[201~");
  const back = async () => { key("\x1b"); await new Promise(resolve => setTimeout(resolve, 80)); };
  await visible("1 teams"); key("\r"); await visible("Team briefing"); key("\r"); await visible("In progress"); await visible("Review release"); await back(); key("\t"); await visible("Enter sessions");
  key("\r"); await visible("Use existing folder"); key("\r"); await visible("Workspace path");
  paste(path.join(home, "missing")); key("\r"); key("\r"); key("\r");
  await visible("ENOENT"); assert.match(output.getViewport().join("\n"), /missing/);
  await back(); await visible("Enter sessions");
  key("\x1b[B"); key(" "); await visible("Edit role and responsibility");
  key("\x1b[B"); key("\x1b[B"); key("\x1b[B"); key("\r"); await visible("Member responsibility");
  paste("Coordinator"); key("\r"); paste("Integrate release evidence"); key("\r"); await visible("Integrate release evidence");
  await client.request("createWorkspace", { teamId: team.id, name: "Reviewer" });
  await visible("Reviewer"); key("\r"); await visible("+ New conversation"); key("\r");
  for (let i = 0; !chats.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(chats[0]?.agent.id, lead.id, "live updates must preserve selected member identity");
  const saved = await client.request("attachSession", { agentId: lead.id, teamId: team.id });
  await client.request("bindSession", { sessionId: saved.id, runtimeSessionId: "20261005_selected_history" });
  await visible("20261005_selected_history"); key("\x1b[B"); key("\r");
  for (let i = 0; chats.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(chats[1]?.runtimeSessionId, "20261005_selected_history");
  assert.equal(chats[1]?.agent.canonicalWorkspace, lead.canonicalWorkspace);
  assert.equal(chats[1]?.teamId, team.id);
  await visible("+ New conversation"); await back(); await visible("Enter sessions"); key("\t"); await visible("+ Assign task");
  key("\x1b[B"); key(" "); await visible("Change queue priority");
  key("\x1b[B"); key("\x1b[B"); key("\x1b[B"); key("\r"); await visible("Queue priority");
  key("\x1b[A"); key("\r"); await visible("high priority");
  assert.equal((await client.request("getTask", { taskId: task.id })).priority, "high");
  key(" "); await visible("Cancel task");
  for (let i = 0; i < 4; i++) key("\x1b[B");
  key("\r"); await visible("Cancel task?"); key("\x1b[B"); key("\r"); await visible("Cancelled");
  assert.equal((await client.request("getTask", { taskId: task.id })).status, "cancelled");
  key("\x1b[D"); await visible("Enter open"); key("\x1b[H"); key("\x1b[B"); key("\r");
  for (let i = 0; chats.length < 3 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(chats[2]?.manager, true);
  await visible("Enter open");
  const managerSession = await client.request("attachSession", { manager: true });
  await client.request("bindSession", { sessionId: managerSession.id, runtimeSessionId: "20261005_manager_history" });
  key("\x1b[H"); key("\r"); await visible("20261005_manager_history");
  key("/"); key("manager_history"); key("\r"); key("\r");
  for (let i = 0; chats.length < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(chats[3]?.manager, true, "Manager history must retain its restricted identity from global Overview");
  assert.equal(chats[3]?.runtimeSessionId, "20261005_manager_history");
  assert.equal(chats[3]?.teamId, undefined);
  abort.abort(); await running;
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isRaw, true);
  main.start({ acquireInput: false }); main.replayAll(); await visible("Original conversation");
  assert.doesNotMatch(output.getViewport().join("\n"), /Team briefing|Manager coordinates/);
});

test("agents page assembles arbitrary folders, chooses the first leader and preserves return controls", { timeout: 15000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-page-"));
  const workspace = path.join(home, "finance"); await mkdir(workspace);
  const launch = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(launch);
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  const input = createVirtualInput(), output = createVirtualOutput();
  const running = runAgentsPage({ launch, input, output: output.output });
  t.after(async () => { input.send("\x03"); await running; client.close(); await server.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
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
  await visible("+ Create team"); input.send("\x1b[<0;5;9M"); await visible("Team name");
  paste("Accounts"); input.send("\r"); await visible("+ Add member");
  input.send("\x1b[<0;5;5M"); await visible("Team briefing");
  input.send("\x1b[<0;15;5M"); await visible("+ Add member");
  input.send("\x1b[<0;5;8M"); await visible("Use existing folder");
  input.send("\x1b[<0;5;5M"); await visible("Workspace path"); paste(workspace); input.send("\r");
  paste("Finance"); input.send("\r"); paste("Reconcile invoices"); input.send("\r");
  await visible("Member added");
  input.send("\x1b[<2;5;10M"); await visible("Edit role and responsibility"); input.send("\x1b");
  const view = await client.request("snapshot");
  assert.equal(view.teams[0].leaderAgentId, view.agents[0].id);
  assert.equal(view.memberships[0].responsibility, "Reconcile invoices");
  for (const width of [40, 80, 120]) {
    output.resize(width, 20); await visible("Agents");
    assert.ok(output.getViewport().every(line => line.length <= width));
  }
  input.send("\x1b"); await new Promise(resolve => setTimeout(resolve, 80)); await visible("Enter open"); input.send("\x1b"); await running;
  assert.equal(input.isRaw, false);
});
