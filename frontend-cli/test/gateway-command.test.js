import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFrontendCliApp } from "../lib/frontend-cli-implementation.js";
import { cliHelp, gatewayHelp, runGateway } from "../lib/one-shot.js";

test("cliHelp documents rind gateway", () => {
  assert.match(gatewayHelp, /Usage: rind gateway/);
  assert.ok(cliHelp.includes(gatewayHelp));
});

test("runGateway spawns runtime with gateway subcommand, forwards SIGINT/SIGTERM, and returns exit code", async () => {
  const procEvents = new EventEmitter();
  const signalsSent = [];
  let spawned = null;

  const fakeChild = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null,
    kill(sig) {
      signalsSent.push(sig);
    },
  });

  const codePromise = runGateway({
    args: ["doctor", "--config", "/tmp/gateway.json"],
    repoRoot: path.join("repo", "root"),
    runtimePath: "",
    cwd: "/tmp",
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      return fakeChild;
    },
    processObj: procEvents,
  });

  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args, [
    path.join("repo", "root", "runtime", "dist", "cli.js"),
    "gateway",
    "doctor",
    "--config",
    "/tmp/gateway.json",
  ]);
  assert.equal(spawned.options.stdio, "inherit");
  assert.equal(spawned.options.cwd, "/tmp");

  procEvents.emit("SIGINT");
  procEvents.emit("SIGTERM");
  assert.deepEqual(signalsSent, ["SIGINT", "SIGTERM"]);

  fakeChild.exitCode = 7;
  fakeChild.emit("exit", 7, null);
  const exitCode = await codePromise;
  assert.equal(exitCode, 7);
  assert.equal(procEvents.listenerCount("SIGINT"), 0);
  assert.equal(procEvents.listenerCount("SIGTERM"), 0);
});

test("runFrontendCliApp routes 'gateway' subcommand and --help directly to runtime gateway entry", async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rind-gateway-cli-"));
  const recordedFile = path.join(tempDir, "recorded.json");
  const fakeRuntime = path.join(tempDir, "fake-runtime.cjs");
  writeFileSync(
    fakeRuntime,
    `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(recordedFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n`,
    "utf8",
  );

  const prevRuntimePath = process.env.RIND_RUNTIME_PATH;
  const prevExitCode = process.exitCode;
  process.env.RIND_RUNTIME_PATH = fakeRuntime;
  t.after(() => {
    if (prevRuntimePath === undefined) delete process.env.RIND_RUNTIME_PATH;
    else process.env.RIND_RUNTIME_PATH = prevRuntimePath;
    process.exitCode = prevExitCode;
    rmSync(tempDir, { recursive: true, force: true });
  });

  await runFrontendCliApp(["gateway", "--help", "--config", "gw.json"]);
  assert.equal(process.exitCode, 3);
  const recordedArgs = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(recordedFile, "utf8")));
  assert.deepEqual(recordedArgs, ["gateway", "--help", "--config", "gw.json"]);
});
