import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { matchServiceProcesses } from "../dist/service-process.js";
import { buildId } from "../../rind-runtime-client/build-id.js";

const B = String.fromCharCode(92), Q = String.fromCharCode(34);
const win = (...parts) => parts.join(B);

test("older services are matched by script and data folder from their command line", () => {
  const script = win("C:", "rind", "agent-management", "dist", "server.js");
  const json = config => B + Q + "{" + Object.entries(config).map(([k, v]) => B + Q + k + B + Q + ":" + B + Q + v.replaceAll(B, B + B) + B + Q).join(",") + "}" + B + Q;
  const list = [
    "101\tnode " + script + " " + json({ python: "python", repoRoot: win("C:", "rind") }),
    "102\tnode " + script + " " + json({ home: win("C:", "Temp", "test-home"), python: "python" }),
    "103\tnode " + win("C:", "other", "server.js") + " {}",
    "104\tnode " + win("C:", "rind", "rind-runtime-client", "shared-server.js") + " " + json({ rindHome: win("C:", "Temp", "test-home") }),
    "garbage line",
  ].join("\r\n");
  assert.deepEqual(matchServiceProcesses(list, script, config => !config.home), [101], "the default data folder has no home field");
  assert.deepEqual(matchServiceProcesses(list, script, config => config.home === win("C:", "Temp", "test-home")), [102]);
  const runtime = win("D:", "elsewhere", "rind", "rind-runtime-client", "shared-server.js");
  assert.deepEqual(matchServiceProcesses(list, runtime, config => Boolean(config.rindHome)), [104], "the install folder may differ; the script's own path tail must match");
  assert.deepEqual(matchServiceProcesses("1 ps -axo\n2 node /opt/rind/agent-management/dist/server.js {\"home\":\"/h\"}", "/x/agent-management/dist/server.js", c => c.home === "/h"), [2]);
});

test("build ids depend on file names and contents, not on where the code is installed", async t => {
  const make = async name => {
    const root = await mkdtemp(path.join(os.tmpdir(), name));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1;");
    await writeFile(path.join(root, "worker.bin"), "binary");
    return root;
  };
  const a = await make("rind-build-a-"), b = await make("rind-build-b-");
  t.after(() => Promise.all([a, b].map(root => rm(root, { recursive: true, force: true }))));
  const id = root => buildId([{ root: path.join(root, "src"), extensions: [".js"] }, { file: path.join(root, "worker.bin") }]);
  assert.equal(await id(a), await id(b));
  await writeFile(path.join(b, "worker.bin"), "changed");
  const fresh = await buildId([{ root: path.join(b, "src"), extensions: [".js"] }, { file: path.join(b, "worker.bin") }, { root: path.join(b, "none"), extensions: [".js"] }]);
  assert.notEqual(fresh, await id(a), "changed contents change the id");
});
