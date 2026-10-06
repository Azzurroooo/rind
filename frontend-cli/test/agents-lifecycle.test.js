import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHandoff, writeHandoff, takeHandoffPath, HANDOFF_ENV } from "../lib/agents-handoff.js";
import { followConversation } from "../lib/agents-commands.js";
import { runAgentsPage } from "../lib/agents-page.js";
import { plainSession } from "../lib/agents-session.js";
import { startServer } from "../../agent-management/dist/ipc.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { createVirtualInput, createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";

test("resuming a plain conversation from another folder opens it in the folder it was saved in", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-resume-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "sessions", "20261006_abc"), { recursive: true });
  await writeFile(path.join(home, "sessions", "20261006_abc", "meta.json"), JSON.stringify({ workspace_root: "/work/notes" }));
  assert.deepEqual(await plainSession(["--session", "20261006_abc"], true, home), { args: ["--cwd", "/work/notes", "--session", "20261006_abc"], shared: true });
  assert.deepEqual(await plainSession(["--session", "20261006_abc", "--cwd", "/x"], true, home), { args: ["--session", "20261006_abc", "--cwd", "/x"], shared: true }, "an explicit folder is kept");
  assert.deepEqual(await plainSession(["--session", "../escape"], true, home), { args: ["--session", "../escape"], shared: true });
  assert.deepEqual(await plainSession(["--session", "20261006_abc"], false, home), { args: ["--session", "20261006_abc"], shared: false }, "scripts keep a private worker");
  assert.equal((await plainSession(["--trace-llm"], true, home)).shared, false);
});

test("a handoff without a decision means return, and only valid decisions are accepted", async t => {
  const handoff = await createHandoff();
  t.after(() => handoff.dispose());
  assert.deepEqual(await handoff.read(), { action: "return" });
  assert.equal(await writeHandoff({ action: "leave" }, ""), false, "a top-level window has nowhere to hand off");
  assert.equal(await writeHandoff({ action: "leave" }, handoff.file + ".missing/x"), false, "a vanished opener is not an error");
  await writeHandoff({ action: "open" }, handoff.file);
  assert.deepEqual(await handoff.read(), { action: "return" }, "open without a conversation is ignored");
  await writeHandoff({ action: "leave" }, handoff.file);
  assert.deepEqual(await handoff.read(), { action: "leave" });
  const env = { [HANDOFF_ENV]: handoff.file, OTHER: "1" };
  assert.equal(takeHandoffPath(env), handoff.file);
  assert.deepEqual(env, { OTHER: "1" }, "services started from the window do not inherit it");
});

test("moving between conversations replaces the window instead of nesting it", async () => {
  const opened = [];
  const steps = [{ action: "open", chat: { runtimeSessionId: "b" } }, { action: "open", chat: { runtimeSessionId: "c" } }, { action: "agents" }];
  const next = await followConversation({ runtimeSessionId: "a" }, { launch: {}, open: async chat => { opened.push(chat.runtimeSessionId); return steps.shift(); } });
  assert.deepEqual(opened, ["a", "b", "c"]);
  assert.deepEqual(next, { action: "agents" });
  assert.deepEqual(await followConversation({}, { launch: {}, open: async () => undefined }), { action: "return" });
});

async function cli(t, { handoff, columns = 100, rows = 26, tty = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-lifecycle-"));
  const workspace = path.join(home, "workspace");
  await mkdir(path.join(workspace, ".rind"), { recursive: true });
  await writeFile(path.join(workspace, ".rind", "settings.json"), JSON.stringify({ provider: "openai-compatible", model: "fixture-model", baseUrl: "http://127.0.0.1:1/v1" }));
  const script = `
    if (${tty}) {
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
    }
    process.stdout.columns = ${columns}; process.stdout.rows = ${rows};
    const { runFrontendCliApp } = await import(${JSON.stringify(new URL("../lib/frontend-cli-implementation.js", import.meta.url).href)});
    await runFrontendCliApp(['--cwd', ${JSON.stringify(workspace)}]);
  `;
  const env = { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1", ...(handoff ? { [HANDOFF_ENV]: handoff.file } : {}) };
  if (!handoff) delete env[HANDOFF_ENV];
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const output = createVirtualOutput({ columns, rows });
  child.stdout.on("data", value => output.output.write(value));
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; await removeRindHome(home); });
  const screen = async () => (await output.flushAndGetViewport()).join("\n");
  return {
    key: value => child.stdin.write(value), exited, screen,
    async visible(text) {
      for (let i = 0; i < 600; i++) { const s = await screen(); if (s.includes(text)) return s; if (child.exitCode !== null) break; await new Promise(r => setTimeout(r, 25)); }
      assert.fail("Expected " + text + "\n" + await screen() + "\n" + errors);
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 150)),
  };
}

test("a conversation window hands Agents navigation back to the window that opened it", { timeout: 40000 }, async t => {
  const handoff = await createHandoff(); t.after(() => handoff.dispose());
  const app = await cli(t, { handoff });
  await app.visible("← agents");
  app.key("\x1b[D");
  assert.equal(await app.exited, 0);
  assert.deepEqual(await handoff.read(), { action: "agents" }, "Left asks the opener for Agents instead of nesting a page");
});

test("ctrl+c clears typing, then needs a second press to leave every window", { timeout: 40000 }, async t => {
  const handoff = await createHandoff(); t.after(() => handoff.dispose());
  const app = await cli(t, { handoff });
  await app.visible("← agents");
  app.key("draft"); await app.visible("draft");
  app.key("\x03"); await app.settle();
  assert.doesNotMatch(await app.screen(), /draft/, "the first ctrl+c clears what is typed");
  app.key("\x03"); await app.visible("ctrl+c again to leave Rind");
  app.key("x"); await app.settle();
  assert.doesNotMatch(await app.screen(), /again to leave/, "any other key cancels leaving");
  app.key("\x7f\x03"); await app.visible("ctrl+c again to leave Rind");
  app.key("\x03");
  assert.equal(await app.exited, 0);
  assert.deepEqual(await handoff.read(), { action: "leave" });
});

test("without a terminal a single ctrl+c leaves, since no hint could be seen", { timeout: 40000 }, async t => {
  const app = await cli(t, { tty: false });
  await app.visible("Ask Rind").catch(() => {});
  await app.settle();
  app.key("\x03");
  const code = await Promise.race([app.exited, new Promise(resolve => setTimeout(() => resolve("still running"), 15000))]);
  assert.equal(code, 0);
});

test("a top-level window leaves on the second ctrl+c", { timeout: 40000 }, async t => {
  const app = await cli(t);
  await app.visible("← agents");
  app.key("\x03"); await app.visible("ctrl+c again to leave Rind");
  app.key("\x03");
  assert.equal(await app.exited, 0);
});

test("the Agents page follows conversation moves and leaving closes it for its opener", { timeout: 20000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-lifecycle-page-"));
  const launch = { home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  const server = await startServer(launch);
  const client = await connectClient({ endpoint: server.paths.endpoint, token: (await readFile(server.paths.token, "utf8")).trim() });
  let stopPage = async () => {};
  // One ordered teardown: close the page first, or it would reconnect by
  // starting a detached service in this temporary home when the server stops.
  t.after(async () => {
    await stopPage();
    client.close(); await server.close();
    await removeRindHome(home);
  });
  const team = await client.request("createTeam", { name: "Crew" });
  const lead = await client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  const input = createVirtualInput(), output = createVirtualOutput({ columns: 120, rows: 30 });
  const visible = async text => {
    for (let i = 0; i < 200; i++) { const s = (await output.flushAndGetViewport()).join("\n"); if (s.includes(text)) return s; await new Promise(r => setTimeout(r, 20)); }
    assert.fail("Expected " + text + "\n" + output.getViewport().join("\n"));
  };
  const opened = [];
  const steps = [{ action: "open", chat: { agent: { id: lead.id, canonicalWorkspace: lead.canonicalWorkspace }, teamId: team.id, runtimeSessionId: "second" } }, { action: "agents" },
    { action: "leave" }];
  const abort = new AbortController();
  const running = runAgentsPage({ launch, input, output: output.output, initialTeamId: team.id, signal: abort.signal, openChat: async chat => { opened.push(chat.runtimeSessionId || "new"); return steps.shift(); } });
  stopPage = async () => { abort.abort(); await running; };
  const until = async (check, label) => { for (let i = 0; i < 150 && !check(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(check(), label); };
  await visible("Leader"); await visible("connected");
  input.send("c");
  await until(() => opened.length === 2, "a move from one conversation to another reuses the page's slot");
  assert.deepEqual(opened, ["new", "second"]);
  await visible("c new chat");
  input.send("\x03"); await visible("again to leave Rind");
  input.send("\x1b");
  for (let i = 0; i < 50 && output.getViewport().join("\n").includes("again to leave Rind"); i++) await output.flushAndGetViewport();
  assert.doesNotMatch((await output.flushAndGetViewport()).join("\n"), /again to leave Rind/, "esc cancels leaving");
  assert.match(output.getViewport().join("\n"), /c new chat/, "esc did not navigate away while cancelling");
  input.send("c");
  const result = await Promise.race([running, new Promise(r => setTimeout(() => r("timeout"), 5000))]);
  assert.equal(result.leave, true, "leaving from a conversation closes the page for its opener");
});
