import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildRuntimeEnv } from "../lib/runtime-env.js";

test("buildRuntimeEnv pins Python stdio to UTF-8", () => {
  const repoRoot = path.join("repo", "root");
  const env = buildRuntimeEnv(repoRoot, {
    PATH: "bin",
    PYTHONIOENCODING: "gbk",
    PYTHONPATH: "existing",
    PYTHONUTF8: "0",
  });

  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONPATH, `${repoRoot}${path.delimiter}existing`);
  assert.equal(env.PATH, "bin");
});
