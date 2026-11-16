import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildRuntimeEnv } from "../lib/runtime-env.js";

test("buildRuntimeEnv preserves base environment and sets RIND_HOME when requested", () => {
  const repoRoot = path.join("repo", "root");
  const env = buildRuntimeEnv(repoRoot, {
    PATH: "bin",
  }, {
    sourceRuntime: true,
    rindHome: "user-data",
  });

  assert.equal(env.PATH, "bin");
  assert.equal(env.RIND_HOME, "user-data");
});

test("buildRuntimeEnv preserves packaged runtime environment and accepts RIND_HOME", () => {
  const env = buildRuntimeEnv("repo", { PATH: "bin" }, {
    sourceRuntime: false,
    rindHome: "user-data",
  });

  assert.deepEqual(env, { PATH: "bin", RIND_HOME: "user-data" });
});
