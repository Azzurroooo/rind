import assert from "node:assert/strict";
import test from "node:test";

import { ToolBlock } from "../lib/components/tool-block.js";
import { stripAnsi } from "../lib/text-width.js";

const WIDTH = 60;

function editEvent() {
  return {
    tool_call_id: "call-1",
    tool_name: "edit_file",
    args_preview: JSON.stringify({ file_path: "src/app.ts" }),
    arguments: { file_path: "src/app.ts" },
  };
}

const MANY_DIFF_LINES = [
  ...Array.from({ length: 30 }, (_, index) => ({ kind: "added", text: `new ${index}` })),
];

test("tool block starts running and mutates in place on finish", () => {
  const renders = [];
  const block = new ToolBlock({ event: editEvent(), onRequestRender: () => renders.push(1) });
  assert.equal(block.isRunning, true);

  const runningLines = block.render(WIDTH).map(stripAnsi);
  assert.match(runningLines[0], /^  ◌ edit src\/app\.ts$/);

  block.finish({
    status: "completed",
    duration_ms: 40,
    result: JSON.stringify({ ok: true, data: {} }),
  }, { file_path: "src/app.ts", lines: [{ kind: "added", text: "hi" }] });

  assert.equal(block.isRunning, false);
  assert.equal(block.timer, null, "ticker cleared after finish");
  assert.ok(renders.length >= 1, "mutations request re-renders");

  const doneLines = block.render(WIDTH).map(stripAnsi);
  assert.match(doneLines[0], /^  ◉ edit src\/app\.ts \(\+1 -0\)$/);
  assert.match(doneLines[1], /hi/);
});

test("collapsed caps hide extra lines; expanding reveals them", () => {
  const block = new ToolBlock({ event: editEvent(), onRequestRender: () => {} });
  block.finish({
    status: "completed",
    duration_ms: 10,
    result: JSON.stringify({ ok: true, data: {} }),
  }, { file_path: "src/app.ts", lines: MANY_DIFF_LINES });

  const collapsed = block.render(WIDTH);
  assert.equal(collapsed.length, 22); // title + 20 + footer

  block.setExpanded(true);
  const expanded = block.render(WIDTH);
  assert.ok(expanded.length > 30);
  assert.ok(!expanded.map(stripAnsi).some((line) => line.includes("more lines")));
});

test("progress messages only apply while running", () => {
  let renders = 0;
  const block = new ToolBlock({ event: {
    tool_call_id: "call-2",
    tool_name: "bash",
    args_preview: '{"command":"npm run dev"}',
    arguments: { command: "npm run dev" },
  }, onRequestRender: () => { renders += 1; } });

  block.setProgress("still running (10s)");
  const running = block.render(WIDTH).map(stripAnsi);
  assert.match(running.at(-1), /still running \(10s\)/);

  block.finish({ status: "completed", duration_ms: 5000, result: JSON.stringify({ ok: true, data: { exit_code: 0 } }) });
  const before = renders;
  block.setProgress("late message");
  assert.equal(renders, before, "progress after finish is ignored");
});

test("late-arriving tool_requested arguments enrich a bare running block", () => {
  let renders = 0;
  const block = new ToolBlock({ event: {
    tool_call_id: "call-9",
    tool_name: "bash",
  }, onRequestRender: () => { renders += 1; } });

  const bare = block.render(WIDTH).map(stripAnsi);
  assert.match(bare[0], /^  ◌ \$ … · 0s$/);

  block.enrichArgs({
    tool_call_id: "call-9",
    tool_name: "bash",
    args_preview: '{"command":"date"}',
    arguments: { command: "date" },
  });
  assert.ok(renders >= 1, "enrichment requests re-render");
  const enriched = block.render(WIDTH).map(stripAnsi);
  assert.match(enriched[0], /^  ◌ \$ date/);
});

test("ticker only exists for long-running tools", () => {
  const quick = new ToolBlock({ event: {
    tool_call_id: "call-3",
    tool_name: "read_file",
    args_preview: '{"path":"a.txt"}',
    arguments: { path: "a.txt" },
  }, onRequestRender: () => {} });
  assert.equal(quick.timer, null);

  const slow = new ToolBlock({ event: editEvent(), onRequestRender: () => {} });
  slow.finish({ status: "completed", duration_ms: 5, result: "{}" });
});
