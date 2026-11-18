import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { buildId } from "../../runtime/dist/client/build-id.js";

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
