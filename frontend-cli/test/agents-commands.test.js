import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { removeRindHome } from "./helpers/rind-home.js";
import { connectSharedRuntime } from "../../runtime/dist/client/shared-runtime.js";
import { managerWorkspace, openAgentChat } from "../lib/agents-commands.js";

const rindBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));

function rind(home, cwd, ...args) {
  const env = { ...process.env, RIND_HOME: home, NO_COLOR: "1" };
  delete env.RIND_SHARED_HOST_PID;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rindBin, ...args], { cwd, env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("rind agents lists state and leaves teams and tasks to the Agents page", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-agents-commands-"));
  const home = path.join(root, "home");
  t.after(async () => {
    await rind(home, root, "agents", "stop", "--all");
    await removeRindHome(home);
    await removeRindHome(root);
  });

  // The very first command starts the service; it must not fail on credentials the service is still writing.
  const empty = await rind(home, root, "agents", "list");
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /No teams yet\. Create one on the Agents page/);

  for (const removed of [["task", "Legacy", "Main", "Review the change"], ["team", "create", "notes"], ["open", "Legacy/Main"], ["import", "legacy"]]) {
    const refused = await rind(home, root, "agents", ...removed);
    assert.equal(refused.code, 2, removed.join(" "));
    assert.match(refused.stderr, /Usage: rind agents \[list \| stop \| resolve\]/);
    assert.match(refused.stderr, /Teams and tasks are managed on the Agents page or by the Manager\./);
  }

  const listed = JSON.parse((await rind(home, root, "agents", "list", "--json")).stdout);
  assert.deepEqual(listed.teams, []);
  assert.deepEqual(listed.tasks, []);
});

test("rind agents stop also stops a shared Runtime that only plain conversations started", { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-agents-stop-"));
  t.after(() => removeRindHome(home));
  const options = { rindHome: home, repoRoot: fileURLToPath(new URL("../..", import.meta.url)) };
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

test("openAgentChat creates the Manager private workspace directory before spawning in a fresh home", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-manager-open-"));
  const home = path.join(root, "fresh-home");
  t.after(() => removeRindHome(root));
  const probeScript = path.join(root, "probe-window.mjs");
  await writeFile(
    probeScript,
    `import { writeFileSync } from "node:fs";
const handoffFile = process.env.RIND_AGENTS_HANDOFF;
if (handoffFile) writeFileSync(handoffFile, JSON.stringify({ action: "leave", from: { workspace: process.cwd() } }));
process.exit(0);
`,
  );
  const expectedDir = managerWorkspace({ home });
  assert.equal(existsSync(expectedDir), false);
  const next = await openAgentChat({ manager: true, launch: { home }, windowScript: probeScript });
  assert.equal(existsSync(expectedDir), true);
  assert.equal(next.action, "leave");
});

