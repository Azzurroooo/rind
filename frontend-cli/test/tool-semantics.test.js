import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTaskStatus,
  parseStructuredToolPayload,
  partialJsonStrings,
  toolTruncationMeta,
  unwrapNestedToolData,
} from "../../rind-runtime-client/tool-semantics.js";
import { delegatedTask, parseToolResult as cliParseToolResult } from "../lib/tool-display.js";
import { parseToolResult as webParseToolResult, partialJsonStrings as webPartialJsonStrings } from "../../frontend-web/src/lib/tools/parse.js";
import { taskFinishState as webTaskFinishState } from "../../frontend-web/src/lib/tools/runTools.js";

test("tool-semantics partialJsonStrings decodes streaming escapes and incomplete unicode cleanly", () => {
  assert.deepEqual(
    partialJsonStrings('{"path":"src/app.ts","content":"line 1\\nline'),
    { path: "src/app.ts", content: "line 1\nline" },
  );
  assert.deepEqual(partialJsonStrings('{"path":"a\\'), { path: "a" });
  assert.deepEqual(partialJsonStrings('{"path":"a\\u00'), { path: "a" });
  assert.deepEqual(partialJsonStrings('{"path":"a\\\\u0041"}'), { path: "a\\u0041" });
  assert.deepEqual(webPartialJsonStrings('{"command":"npm te'), { command: "npm te" });
});

test("tool-semantics parseStructuredToolPayload and unwrapNestedToolData align across CLI and Web", () => {
  assert.deepEqual(parseStructuredToolPayload('{"ok":true,"data":{"a":1}}'), {
    structured: true,
    payload: { ok: true, data: { a: 1 } },
    parsed: { ok: true, data: { a: 1 } },
  });
  assert.equal(parseStructuredToolPayload("[1,2]").structured, false);
  assert.equal(parseStructuredToolPayload("plain").structured, false);

  assert.deepEqual(cliParseToolResult("plain"), {});
  assert.deepEqual(webParseToolResult("plain"), { data: "plain" });
  assert.deepEqual(webParseToolResult("[1,2]"), { data: [1, 2] });

  const nested = JSON.stringify({
    ok: true,
    data: JSON.stringify({ result: { taskId: "t-9", assignee: "Analyst", status: "completed" } }),
  });
  assert.deepEqual(delegatedTask(nested), { taskId: "t-9", assignee: "Analyst", status: "completed" });
  assert.deepEqual(unwrapNestedToolData('{"result":{"ok":1}}'), { ok: 1 });
});

test("tool-semantics classifyTaskStatus and toolTruncationMeta handle all status and paging edge cases", () => {
  for (const state of ["starting", "running", "cancelling"]) {
    assert.equal(classifyTaskStatus(state), "running");
    assert.equal(webTaskFinishState(state), "running");
  }
  for (const state of ["failed", "timed_out", "lost"]) {
    assert.equal(classifyTaskStatus(state), "error");
    assert.equal(webTaskFinishState(state), "error");
  }
  for (const state of ["cancelled", "canceled"]) {
    assert.equal(classifyTaskStatus(state), "cancelled");
    assert.equal(webTaskFinishState(state), "cancelled");
  }
  assert.equal(classifyTaskStatus("completed"), "success");
  assert.equal(classifyTaskStatus(""), "");

  assert.deepEqual(toolTruncationMeta({ truncated: true, total_bytes: 8192, next_offset: 1001 }), {
    truncated: true,
    totalBytes: 8192,
    nextOffset: 1001,
    hasMorePages: true,
  });
  assert.deepEqual(toolTruncationMeta({ truncated: false, next_offset: null }), {
    truncated: false,
    totalBytes: null,
    nextOffset: null,
    hasMorePages: false,
  });
});
