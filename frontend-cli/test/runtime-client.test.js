import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createRuntimeClient, resolveRuntimeLaunch } from "../lib/runtime-client.js";

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

  await assert.rejects(client.request("initialize"), /Runtime (exited|stdin is closed)/);
  const result = await exited;

  assert.notEqual(result.code, 0);
  assert.equal(result.details.closing, false);
  assert.match(result.details.error.message, /Runtime exited/);
});
