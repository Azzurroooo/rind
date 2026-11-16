import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readCliVersion } from "../lib/version.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "rind-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const frontend = path.join(root, "frontend-cli");
  mkdirSync(frontend);
  writeFileSync(path.join(frontend, "package.json"), '{"type":"module"}');
  return { root, frontend };
}

test("source version follows runtime/src/version.ts without a separately maintained CLI version", (t) => {
  const { root, frontend } = fixture(t);
  mkdirSync(path.join(root, "runtime", "src"), { recursive: true });
  const source = path.join(root, "runtime", "src", "version.ts");
  for (const version of ["9.8.7", "9.8.8"]) {
    writeFileSync(source, `export const RIND_VERSION = "${version}";\n`);
    assert.equal(readCliVersion(frontend), version);
  }
});

test("installed CLI reads generated package metadata without runtime source", (t) => {
  const { frontend } = fixture(t);
  writeFileSync(path.join(frontend, "package.json"), '{"version":"9.8.7"}');
  assert.equal(readCliVersion(frontend), "9.8.7");
});

test("repository CLI version matches the runtime version source", () => {
  const source = readFileSync(new URL("../../runtime/src/version.ts", import.meta.url), "utf8");
  assert.equal(readCliVersion(), source.match(/RIND_VERSION\s*=\s*"([^"]+)"/)[1]);
});
