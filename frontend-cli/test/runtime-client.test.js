import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createRuntimeClient, resolveRuntimeLaunch } from "../lib/runtime-client.js";

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
