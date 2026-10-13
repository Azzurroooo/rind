import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPromptHistory, savePromptHistory } from "../lib/prompt-history-store.js";

test("prompt history persists newest entries and ignores malformed lines", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-prompt-history-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  assert.equal(savePromptHistory(["newest", "older", "older"], root), true);
  assert.deepEqual(loadPromptHistory(root), ["newest", "older"]);

  const file = path.join(root, "cli-history.jsonl");
  const content = await readFile(file, "utf8");
  assert.match(content, /"older"/);
  assert.match(content, /"newest"/);
});

test("prompt history tolerates malformed storage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-prompt-history-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(root, "cli-history.jsonl"), "broken\n\"valid\"\n", "utf8");

  assert.deepEqual(loadPromptHistory(root), ["valid"]);
});
