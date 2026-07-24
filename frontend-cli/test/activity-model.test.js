import assert from "node:assert/strict";
import test from "node:test";

import { createActivityModel } from "../lib/activity-model.js";
import { classifyTool } from "../lib/activity-classifier.js";

test("classifies tools by semantic action and recognizes checks", () => {
  assert.equal(classifyTool("read_file"), "inspect");
  assert.equal(classifyTool("search_files"), "search");
  assert.equal(classifyTool("bash", JSON.stringify({ command: "pytest tests/test_auth.py" })), "check");
  assert.equal(classifyTool("bash", JSON.stringify({ command: "git status" })), "run");
});

test("coalesces consecutive reads until the ledger is flushed", () => {
  let time = 0;
  const model = createActivityModel({ now: () => time });
  for (const [id, path] of [["one", "agent/a.py"], ["two", "agent/b.py"]]) {
    model.handle({ type: "tool_requested", tool_call_id: id, tool_name: "read_file", args_preview: JSON.stringify({ path }) });
    time += 150;
    const result = model.handle({ type: "tool_result", tool_call_id: id, tool_name: "read_file", status: "completed", duration_ms: 150 });
    assert.equal(result.pending, true);
  }
  const rows = model.flushPending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "2 files");
  assert.equal(rows[0].durationMs, 300);
});

test("keeps different search queries as separate rows", () => {
  const model = createActivityModel();
  for (const [id, query] of [["one", "token"], ["two", "refresh"]]) {
    model.handle({ type: "tool_requested", tool_call_id: id, tool_name: "search_files", args_preview: JSON.stringify({ query, path: "agent/" }) });
    model.handle({ type: "tool_result", tool_call_id: id, tool_name: "search_files", status: "completed", duration_ms: 10 });
  }
  assert.equal(model.flushPending().length, 2);
});

test("tracks file changes, test counts, and failures in the receipt", () => {
  const model = createActivityModel();
  model.handle({ type: "tool_requested", tool_call_id: "change", tool_name: "apply_patch", args_preview: JSON.stringify({ path: "auth.py" }) });
  model.handle({ type: "file_change", tool_call_id: "change", file_path: "auth.py", lines: [{ kind: "added", text: "new" }, { kind: "removed", text: "old" }] });
  model.handle({ type: "tool_result", tool_call_id: "change", tool_name: "apply_patch", status: "completed", duration_ms: 10 });
  model.handle({ type: "tool_requested", tool_call_id: "check", tool_name: "bash", args_preview: JSON.stringify({ command: "pytest tests" }) });
  model.handle({ type: "tool_result", tool_call_id: "check", tool_name: "bash", status: "completed", duration_ms: 20, result: JSON.stringify({ data: { stdout: "12 passed" } }) });
  const summary = model.summary(1000);
  assert.deepEqual(summary, { tools: 2, failed: 0, changedFiles: 1, added: 1, removed: 1, testsPassed: 12, testsFailed: 0, durationMs: 1000 });
});

test("promotes a completed shell event with a nonzero exit code to fail", () => {
  const model = createActivityModel();
  model.handle({ type: "tool_requested", tool_call_id: "run", tool_name: "bash", args_preview: JSON.stringify({ command: "npm test" }) });
  const result = model.handle({ type: "tool_result", tool_call_id: "run", tool_name: "bash", status: "completed", duration_ms: 10, result: JSON.stringify({ data: { exit_code: 1, stderr: "failed" } }) });
  assert.equal(result.entry.status, "fail");
  assert.equal(model.summary(10).failed, 1);
});
