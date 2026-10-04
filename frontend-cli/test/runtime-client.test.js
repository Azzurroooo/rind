import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createRuntimeClient, resolveRuntimeLaunch } from "../lib/runtime-client.js";

async function shutdownFixture(t, handler) {
  const root = await mkdtemp(path.join(tmpdir(), "rind-shutdown-"));
  await writeFile(path.join(root, "main.py"), `
const fs = require("fs");
const path = require("path");
const reply = (r) => process.stdout.write(JSON.stringify({kind: "response", request_id: r.request_id, result: {ok: true}}) + "\\n");
const input = require("readline").createInterface({input: process.stdin});
let shutdownRequest;
input.on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") reply(r);
  else { ${handler} }
});
`);
  const client = createRuntimeClient({ python: process.execPath, repoRoot: root, rindHome: path.join(root, "home") });
  const runtime = client.start();
  const exited = new Promise((resolve) => runtime.once("close", resolve));
  t.after(async () => {
    t.mock.timers.reset();
    client.forceShutdown();
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  await client.request("initialize");
  return { client, root };
}

test("shutdown allows slow cleanup, joins repeated calls, and waits for process exit", { timeout: 10000 }, async (t) => {
  const { client, root } = await shutdownFixture(t, `
    if (r.method === "shutdown") {
      shutdownRequest = r;
      setInterval(() => {
        if (fs.existsSync(path.join(__dirname, "exit"))) process.exit(0);
      }, 10);
    } else if (r.method === "release") { reply(shutdownRequest); reply(r); }
  `);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shutdown = client.shutdown();
  assert.equal(client.shutdown(), shutdown);
  t.mock.timers.tick(1501);
  assert.equal(client.child.killed, false);
  t.mock.timers.reset();
  let finished = false;
  void shutdown.then(() => { finished = true; });
  await client.request("release");
  assert.equal(finished, false);
  assert.notEqual(client.child, null);
  await writeFile(path.join(root, "exit"), "ready");
  await shutdown;
  assert.equal(client.child, null);
});

test("shutdown preserves cleanup errors and lets the worker finish exiting", { timeout: 10000 }, async (t) => {
  const { client, root } = await shutdownFixture(t, `
    if (r.method === "shutdown") {
      process.stdout.write(JSON.stringify({kind: "response", request_id: r.request_id, error: {type: "ShutdownFailed", message: "termination not confirmed"}}) + "\\n");
      input.once("close", () => {
        fs.writeFileSync(path.join(__dirname, "cleanup"), "finished");
        process.exit(1);
      });
    }
  `);
  await assert.rejects(client.shutdown(), /termination not confirmed/);
  assert.equal(await readFile(path.join(root, "cleanup"), "utf8"), "finished");
  assert.equal(client.child, null);
});

test("shutdown timeout forces exit and rejects instead of reporting success", { timeout: 10000 }, async (t) => {
  const { client } = await shutdownFixture(t, `if (r.method === "shutdown") setInterval(() => {}, 1000);`);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shutdown = client.shutdown();
  const rejected = assert.rejects(shutdown, /shutdown timed out after 30s; forced termination/);
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(client.child, null);
  assert.equal(client.shutdown(), shutdown);
});

test("compact waits beyond 120 seconds while ordinary commands time out", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-rpc-timeout-"));
  await writeFile(path.join(root, "main.py"), `
const pending = [];
const reply = (r) => process.stdout.write(JSON.stringify({kind: "response", request_id: r.request_id, result: {ok: true}}) + "\\n");
require("readline").createInterface({input: process.stdin}).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") reply(r);
  else if (r.method === "release") { pending.splice(0).forEach(reply); reply(r); }
  else if (r.method === "shutdown") { reply(r); process.exit(0); }
  else pending.push(r);
});
`);
  const client = createRuntimeClient({python: process.execPath, repoRoot: root, rindHome: path.join(root, "home")});
  try {
    client.start();
    await client.request("initialize");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let settled = false;
    const compacts = Promise.all([
      client.request("rind/session/compact"),
      client.request("rind/command/execute", { input: " /COMPACT " }),
    ]).then(() => { settled = true; });
    const short = assert.rejects(client.request("rind/command/execute", {input: "/help"}), /timed out after 120s/);
    t.mock.timers.tick(120001);
    await short;
    assert.equal(settled, false);
    t.mock.timers.reset();
    await client.request("release");
    await compacts;
    assert.equal(settled, true);
  } finally {
    t.mock.timers.reset();
    await client.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test("source runtime launch uses the shared app-server entry", () => {
  const repoRoot = path.join("repo", "root");
  const launch = resolveRuntimeLaunch({
    python: "python",
    repoRoot,
    cliArgs: ["--debug", "--session", "session-1"],
  });

  assert.equal(launch.command, "python");
  assert.deepEqual(launch.args, [
    path.join(repoRoot, "main.py"),
    "app-server",
    "--stdio",
    "--debug",
    "--session",
    "session-1",
  ]);
});

test("packaged runtime launch does not depend on the source tree", () => {
  const launch = resolveRuntimeLaunch({
    python: "python",
    repoRoot: "unused",
    runtimePath: "C:\\Rind\\rind-runtime.exe",
    cliArgs: ["--cwd", "workspace"],
  });

  assert.equal(launch.command, "C:\\Rind\\rind-runtime.exe");
  assert.deepEqual(launch.args, ["app-server", "--stdio", "--cwd", "workspace"]);
});

test("runtime exit rejects an in-flight request and reports a recoverable failure", async () => {
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const client = createRuntimeClient({
    python: "unused",
    repoRoot: "unused",
    runtimePath: process.execPath,
    onExit: (code, signal, details) => resolveExit({ code, signal, details }),
  });

  client.start();
  await assert.rejects(client.request("initialize"), /Runtime (exited|stdin is closed)/);
  const result = await exited;

  assert.notEqual(result.code, 0);
  assert.equal(result.details.closing, false);
  assert.match(result.details.error.message, /Runtime exited/);
});

test("runtime client stays stopped until explicit start", async () => {
  const client = createRuntimeClient({
    python: "unused",
    repoRoot: "unused",
    runtimePath: process.execPath,
  });
  assert.equal(client.child, null);
  await assert.rejects(client.request("initialize"), /Runtime is not running/);
  client.forceShutdown();
  assert.equal(client.child, null);
});
