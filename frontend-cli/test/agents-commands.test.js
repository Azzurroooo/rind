import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { removeRindHome } from "./helpers/rind-home.js";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";

const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));

function rind(home, cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rindBin, ...args], { cwd, env: { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("rind agents commands work in a fresh home and read relative folders from where they run", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-agents-commands-"));
  const home = path.join(root, "home");
  const physicalWork = path.join(root, "work");
  const work = path.join(root, "work-alias");
  t.after(async () => {
    await rind(home, root, "agents", "stop", "--all");
    await removeRindHome(home);
    await removeRindHome(root);
  });
  await mkdir(path.join(physicalWork, "lead"), { recursive: true });
  await mkdir(path.join(physicalWork, "nested", "reviewer"), { recursive: true });
  // Exercise real filesystem aliases, including the short paths used by Windows runners.
  await symlink(physicalWork, work, process.platform === "win32" ? "junction" : "dir");

  // The very first command starts the service; it must not fail on credentials the service is still writing.
  const created = await rind(home, path.join(work, "lead"), "agents", "team", "create", "notes");
  assert.equal(created.code, 0, created.stderr);

  // The service runs in another folder than this command; a relative path still means this command's folder.
  const lead = await rind(home, work, "agents", "team", "add", "notes", "lead");
  assert.equal(lead.code, 0, lead.stderr);
  const reviewer = await rind(home, path.join(work, "nested"), "agents", "team", "add", "notes", "./reviewer");
  assert.equal(reviewer.code, 0, reviewer.stderr);
  const listed = await rind(home, root, "agents", "list", "--json");
  assert.equal(listed.code, 0, listed.stderr);
  const folders = JSON.parse(listed.stdout).agents.map(agent => agent.canonicalWorkspace);
  for (const relative of ["lead", path.join("nested", "reviewer")]) {
    const absolute = await realpath(path.join(work, relative));
    const expected = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    assert.ok(folders.includes(expected), `Expected ${expected}; got ${folders.join(", ")}`);
  }
});

test("rind agents stop also stops a shared Runtime that only plain conversations started", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-stop-"));
  t.after(() => removeRindHome(home));
  const options = { rindHome: home, python: process.env.RIND_PYTHON || "python", repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
  (await connectSharedRuntime(options)).close();

  const stopped = await rind(home, home, "agents", "stop");
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped the background services/);
  let host = null;
  for (let i = 0; i < 40 && (host = await connectSharedRuntime({ rindHome: home, start: false }).catch(() => null)); i++) {
    host.close();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(host, null, "the shared Runtime is still running");
});
