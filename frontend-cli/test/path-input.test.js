import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolveInputPath, folderSuggestions, commonCompletion, inspectFolder, checkFolderName } from "../lib/path-input.js";

test("folder inputs resolve home, relative and quoted paths", () => {
  assert.equal(resolveInputPath("~"), os.homedir());
  assert.equal(resolveInputPath("~/work"), path.join(os.homedir(), "work"));
  assert.equal(resolveInputPath("project", "/base"), path.resolve("/base", "project"));
  assert.equal(resolveInputPath('"/tmp/a b"'), path.resolve("/tmp/a b"));
  assert.equal(resolveInputPath("   "), "");
});

test("suggestions list matching folders only, keep the typed prefix and descend with a separator", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["api", "app", "Apps", ".hidden", "docs"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "apple.txt"), "");
  const values = (await folderSuggestions("a", root)).map(s => s.name);
  assert.deepEqual(values, ["api", "app", "Apps"]);
  const nested = await folderSuggestions("./ap", root);
  assert.ok(nested.length === 3 && nested.every(s => s.value.toLowerCase().startsWith("./ap") && /[\\/]$/.test(s.value)));
  assert.deepEqual((await folderSuggestions(".h", root)).map(s => s.name), [".hidden"]);
  assert.deepEqual(await folderSuggestions("missing/x", root), []);
  assert.equal(commonCompletion("a", await folderSuggestions("a", root)), "ap", "shared prefix of api, app and Apps");
  assert.equal(commonCompletion("ap", await folderSuggestions("ap", root)), "ap", "no longer prefix to add");
  assert.equal(commonCompletion("d", await folderSuggestions("d", root)), "docs" + path.sep);
  assert.equal(commonCompletion("ap", [{ value: "app/" }, { value: "apps/" }]), "app");
});

test("folder inspection reports missing paths, files and Git repositories", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rind-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "repo", ".git"), { recursive: true });
  await writeFile(path.join(root, "file"), "");
  assert.equal((await inspectFolder("nope", root)).kind, "missing");
  assert.equal((await inspectFolder("file", root)).kind, "file");
  assert.deepEqual(await inspectFolder("repo", root), { path: path.join(root, "repo"), kind: "folder", git: true });
  assert.equal((await inspectFolder("", root)).kind, "empty");
  assert.equal(checkFolderName("feature-x"), "");
  assert.match(checkFolderName("a/b"), /no slashes/);
});

test("a bare drive letter means the drive root on Windows only", () => {
  const sep = String.fromCharCode(92), drive = "D" + String.fromCharCode(58);
  assert.equal(resolveInputPath(drive, "/base", "win32"), drive + sep);
  assert.equal(resolveInputPath(drive, "/base", "linux"), path.resolve("/base", drive));
});
