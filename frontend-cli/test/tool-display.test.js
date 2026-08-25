import assert from "node:assert/strict";
import test from "node:test";

import {
  renderToolRunning,
  renderToolFinished,
  parseToolArguments,
  parseToolResult,
  argsFromResult,
} from "../lib/tool-display.js";
import { stripAnsi } from "../lib/text-width.js";

const WIDTH = 60;

function bashResult({ stdout = "", stderr = "", exitCode = 0, totalBytes } = {}) {
  return JSON.stringify({
    ok: true,
    tool: "bash",
    data: { status: "completed", stdout, stderr, exit_code: exitCode },
    meta: totalBytes ? { truncated: true, total_bytes: totalBytes, total_lines: 99 } : {},
  });
}

test("running block shows accent glyph, command and elapsed time", () => {
  const lines = renderToolRunning({
    name: "bash",
    args: { command: "npm test" },
    phase: "running",
    elapsedMs: 3200,
    progressMessage: "still running (3s)",
  }, WIDTH);
  assert.equal(lines.length, 2);
  assert.match(stripAnsi(lines[0]), /^◌ \$ npm test · 3s$/);
  assert.match(stripAnsi(lines[1]), /↳ still running \(3s\)/);
});

test("finished bash success shows glyph, duration and output tail", () => {
  const lines = renderToolFinished({
    name: "bash",
    args: { command: "npm test" },
    phase: "done",
    expanded: false,
    event: {
      status: "completed",
      duration_ms: 1230,
      result: bashResult({ stdout: ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n") }),
    },
  }, WIDTH);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^◉ \$ npm test · 1\.23s$/);
  assert.equal(plain.length, 7); // title + 5 tail lines + footer
  assert.match(plain[1], /l3/);
  assert.match(plain[5], /l7/);
  assert.match(plain[6], /\(2 more lines · ctrl\+o to expand\)/);
});

test("finished bash nonzero exit is surfaced in the title", () => {
  const lines = renderToolFinished({
    name: "bash",
    args: { command: "go build ./..." },
    phase: "done",
    expanded: false,
    event: {
      status: "completed",
      duration_ms: 900,
      result: bashResult({ stderr: "boom", exitCode: 2 }),
    },
  }, WIDTH);
  const plain = stripAnsi(lines[0]);
  assert.match(plain, /exit 2/);
  assert.match(plain, /0\.90s|900ms/);
});

test("background running bash keeps a pending presentation", () => {
  const lines = renderToolFinished({
    name: "bash",
    args: { command: "npm run dev" },
    phase: "done",
    expanded: false,
    event: {
      status: "completed",
      duration_ms: 120,
      result: JSON.stringify({ ok: true, data: { status: "running", bg_id: "bg9", stdout: "", stderr: "" } }),
    },
  }, WIDTH);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^◌ \$ npm run dev$/);
  assert.match(plain.at(-1), /running in background \(bg bg9\)/);
});

test("edit_file title carries diff counts and body renders colored diff with footer", () => {
  const fileChange = {
    file_path: "src/app.ts",
    lines: [
      ...Array.from({ length: 25 }, (_, index) => ({ kind: "removed", text: `-old ${index}` })),
      ...Array.from({ length: 25 }, (_, index) => ({ kind: "added", text: `new ${index}` })),
    ],
  };
  const lines = renderToolFinished({
    name: "edit_file",
    args: { file_path: "src/app.ts" },
    phase: "done",
    expanded: false,
    event: { status: "completed", duration_ms: 45, result: JSON.stringify({ ok: true, data: {} }) },
    fileChange,
  }, WIDTH);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^◉ edit src\/app\.ts \(\+25 -25\)$/);
  assert.equal(plain.length, 22); // title + 20 diff + footer
  assert.match(plain.at(-1), /\(30 more lines · ctrl\+o to expand\)/);
  assert.ok(lines[1].includes("\x1b[2m    - ") && lines[1].includes("\x1b[38;2;243;139;168m"));
});

test("write_file falls back to meta diff counts without live file_change", () => {
  const lines = renderToolFinished({
    name: "write_file",
    args: { file_path: "docs/new.md" },
    phase: "done",
    expanded: false,
    event: {
      status: "completed",
      duration_ms: 30,
      result: JSON.stringify({
        ok: true,
        data: {},
        meta: { files: [{ path: "docs/new.md", added_lines: 4, removed_lines: 0 }] },
      }),
    },
  }, WIDTH);
  assert.match(stripAnsi(lines[0]), /^◉ write docs\/new\.md \(\+4 -0\)$/);
});

test("grep collapsed hides listings behind a hint; expanded lists them", () => {
  const result = JSON.stringify({
    ok: true,
    data: [
      { file: "a.ts", line: 3, text: "TODO fix" },
      { file: "b.ts", line: 9, text: "TODO later" },
    ],
    meta: { pattern: "TODO", count: 42 },
  });
  const context = {
    name: "grep", args: { pattern: "TODO", path: "src" }, phase: "done",
    event: { status: "completed", duration_ms: 80, result },
  };
  const collapsed = renderToolFinished({ ...context, expanded: false }, WIDTH);
  const collapsedPlain = collapsed.map(stripAnsi);
  assert.match(collapsedPlain[0], /^◉ grep \/TODO\/ in src · 42 matches$/);
  assert.equal(collapsed.length, 2); // title only + hint
  assert.match(collapsedPlain[1], /\(2 more lines · ctrl\+o to expand\)/);

  const expanded = renderToolFinished({ ...context, expanded: true }, WIDTH);
  const plain = expanded.map(stripAnsi);
  assert.ok(plain.some((line) => line.includes("a.ts:3: TODO fix")));
});

test("bash_output surfaces bg id and waited time from the result payload", () => {
  const lines = renderToolFinished({
    name: "bash_output",
    args: {},
    phase: "done",
    expanded: false,
    event: {
      status: "completed",
      duration_ms: 489,
      result: JSON.stringify({
        ok: true,
        data: { bg_id: "bg_f8e9337e", stdout: "background task done", stderr: "", wait_ms: 3200, elapsed_ms: 3200 },
      }),
    },
  }, WIDTH);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^◉ bg bg_f8e9337e · waited 3\.20s · 489ms$/);
  assert.match(plain[1], /background task done/);
});

test("argsFromResult recovers key arguments from result payloads", () => {
  assert.deepEqual(
    argsFromResult("read_file", JSON.stringify({ meta: { path: "docs/x.md" } })),
    { path: "docs/x.md" },
  );
  assert.deepEqual(
    argsFromResult("edit_file", JSON.stringify({ meta: { files: [{ path: "a.ts" }] } })),
    { file_path: "a.ts" },
  );
  assert.deepEqual(
    argsFromResult("search_web", JSON.stringify({ meta: { query: "rind agent", matches: 3 } })),
    { query: "rind agent" },
  );
  assert.deepEqual(
    argsFromResult("fetch_web_page", JSON.stringify({ meta: { url: "https://x.dev" } })),
    { url: "https://x.dev" },
  );
  assert.deepEqual(argsFromResult("bash", "{}"), {});
});

test("read_file collapsed hides content; expanded shows numbered lines", () => {
  const result = JSON.stringify({
    ok: true,
    data: "Showing lines 1 to 2:\n  1 | first\n  2 | second\n",
    meta: { path: "x.txt", offset: 0, next_offset: null, truncated: false },
  });
  const collapsed = renderToolFinished({
    name: "read_file", args: { path: "x.txt" }, phase: "done", expanded: false,
    event: { status: "completed", duration_ms: 5, result },
  }, WIDTH);
  assert.equal(collapsed.length, 1);

  const expandedRead = renderToolFinished({
    name: "read_file", args: { path: "x.txt", offset: 10, limit: 50 }, phase: "done", expanded: true,
    event: { status: "completed", duration_ms: 5, result },
  }, WIDTH);
  const expandedPlain = expandedRead.map(stripAnsi);
  assert.match(expandedPlain[0], /read x\.txt:10-60/);
  assert.ok(expandedPlain.some((line) => line.includes("1 | first")));
});

test("search_web shows result count and expanded entries", () => {
  const result = JSON.stringify({
    ok: true,
    data: [{ title: "Rind repo", url: "https://example.com/rind", snippet: "" }],
    meta: { matches: 8 },
  });
  const collapsed = renderToolFinished({
    name: "search_web", args: { query: "rind agent" }, phase: "done", expanded: false,
    event: { status: "completed", duration_ms: 400, result },
  }, WIDTH);
  assert.match(stripAnsi(collapsed[0]), /search "rind agent" · 8 results/);

  const expanded = renderToolFinished({
    name: "search_web", args: { query: "rind agent" }, phase: "done", expanded: true,
    event: { status: "completed", duration_ms: 400, result },
  }, WIDTH);
  const plain = expanded.map(stripAnsi);
  assert.ok(plain.some((line) => line.includes("Rind repo")));
  assert.ok(plain.some((line) => line.includes("https://example.com/rind")));
});

test("delegate shows status, summary head and published paths", () => {
  const result = JSON.stringify({
    ok: true,
    data: { agent_id: "reviewer", status: "completed", summary: "All good\nDetails here", published_paths: ["a.md"] },
  });
  const collapsed = renderToolFinished({
    name: "delegate", args: { agent_id: "reviewer", task: "review" }, phase: "done", expanded: false,
    event: { status: "completed", duration_ms: 4200, result },
  }, WIDTH);
  const plain = collapsed.map(stripAnsi);
  assert.match(plain[0], /^◉ delegate → reviewer · completed · 4\.20s$/);
  assert.equal(plain.length, 3); // title + summary head + footer
  assert.match(plain[1], /All good/);

  const expanded = renderToolFinished({
    name: "delegate", args: { agent_id: "reviewer", task: "review" }, phase: "done", expanded: true,
    event: { status: "completed", duration_ms: 4200, result },
  }, WIDTH);
  const expandedPlain = expanded.map(stripAnsi);
  assert.ok(expandedPlain.some((line) => line.includes("Details here")));
  assert.ok(expandedPlain.some((line) => line.includes("published 1 path")));
});

test("failed tools show error detail line", () => {
  const lines = renderToolFinished({
    name: "bash",
    args: { command: "blocked" },
    phase: "done",
    expanded: false,
    event: {
      status: "failed",
      error_type: "DangerousCommandBlocked",
      duration_ms: 10,
      result: JSON.stringify({ ok: false, error: "command matches deny list" }),
    },
  }, WIDTH);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^⊘/);
  assert.match(plain[1], /command matches deny list/);
});

test("generic renderer covers unknown tools", () => {
  const lines = renderToolFinished({
    name: "totally_new_tool",
    args: { name: "custom" },
    phase: "done",
    expanded: false,
    event: { status: "completed", duration_ms: 12, result: "" },
  }, WIDTH);
  assert.match(stripAnsi(lines[0]), /^◉ totally new tool custom$/);
});

test("wide characters are clipped without breaking layout", () => {
  const lines = renderToolRunning({
    name: "bash",
    args: { command: "echo 你好世界你好世界你好世界你好世界你好世界你好世界" },
    phase: "running",
    elapsedMs: 500,
  }, 30);
  const width = 30;
  const visible = stripAnsi(lines[0]).length >= 0;
  assert.ok(visible);
  assert.ok(lines[0].length < width * 4);
});

test("truncation note follows the runtime flag, not length heuristics", () => {
  const base = { name: "bash", args: { command: "date" }, phase: "done", expanded: false };
  const noFlag = renderToolFinished({
    ...base,
    event: {
      status: "completed",
      duration_ms: 10,
      result: JSON.stringify({ ok: true, data: { stdout: "2026-08-24 21:05:47 Monday", stderr: "", exit_code: 0 }, meta: { total_bytes: 27 } }),
    },
  }, WIDTH);
  assert.ok(!noFlag.some((line) => stripAnsi(line).includes("output truncated")), "no note without truncated flag");

  const flagged = renderToolFinished({
    ...base,
    expanded: true,
    event: {
      status: "completed",
      duration_ms: 10,
      result: JSON.stringify({ ok: true, data: { stdout: "a\nb", stderr: "", exit_code: 0 }, meta: { truncated: true, total_bytes: 40000 } }),
    },
  }, WIDTH);
  assert.ok(flagged.some((line) => stripAnsi(line).includes("output truncated (40000 bytes total)")));
});

test("argument and result parsing tolerate junk", () => {
  assert.deepEqual(parseToolArguments({ arguments: { a: 1 } }), { a: 1 });
  assert.deepEqual(parseToolArguments({ args_preview: '{"b":2}' }), { b: 2 });
  assert.deepEqual(parseToolArguments({ args_preview: "not json" }), {});
  assert.deepEqual(parseToolResult("nope"), {});
});
