import test from "node:test";
import assert from "node:assert/strict";
import { taskMonitorFrame } from "../lib/rendering.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

function fixture(count = 100) {
  const items = Array.from({ length: count }, (_, i) => ({ bg_id: `task-${i}`, id: `d${i}`,
    agent_id: `worker-${i}`, status: "completed", command: "中文回测 👩‍💻 é".repeat(30), task: "检查结果",
    summary: "验证完成" }));
  return { page: "background", backgroundCount: count, delegateCount: count, items, index: count - 3,
    selected: items[count - 3], focus: "list", width: 80, height: 18, previewOffset: 0,
    preview: { stdout: Array.from({ length: 60 }, (_, i) => `output-${i}`).join("\n"), stderr: "" } };
}

test("both monitor pages obey every height budget and keep their selected row", () => {
  for (const page of ["background"]) {
    for (const width of [4, 16, 32, 80, 100, 160]) {
      for (let height = 0; height <= 50; height += 1) {
        const params = { ...fixture(), page, width, height };
        const { lines } = taskMonitorFrame(params);
        assert.ok(lines.length <= height, `${page} ${width}x${height}: ${lines.length} rows`);
        assert.ok(lines.every((line) => textWidth(line) <= width), `${page} ${width}x${height}: width overflow`);
        if (width >= 32 && height) {
          assert.match(stripAnsi(lines.join("\n")), page === "background" ? /task-97/ : /worker-97/);
          assert.match(stripAnsi(lines.at(-1)), /esc/);
        }
      }
    }
  }
});

test("normal monitor height reserves six output lines before growing the list", () => {
  for (const [width, height] of [[80, 18], [100, 24], [160, 44]]) {
    const lines = taskMonitorFrame({ ...fixture(), width, height }).lines.map(stripAnsi);
    const rows = lines.filter((line) => /^\s+[›·] task-/.test(line));
    assert.ok(rows.length <= 5 && rows.length >= 1);
    assert.ok(lines.filter((line) => /^\s+output-/.test(line)).length >= 6);
    assert.ok(lines.some((line) => line.includes("98/100")));
    assert.ok(lines.some((line) => line.includes("output-59")));
  }
});

test("foreground action is rendered once and survives small heights", () => {
  for (const height of [1, 2, 3, 4, 5, 8, 18]) {
    const params = { ...fixture(), height, focus: "foreground", foreground: { bg_id: "front", command: "waiting-command" },
      foregroundIndex: 1, foregroundCount: 3 };
    const lines = taskMonitorFrame(params).lines.map(stripAnsi);
    assert.ok(lines.length <= height);
    assert.equal(lines.filter((line) => line.includes("Waiting 2/3")).length, 1);
    assert.match(lines.join("\n"), /r background/);
    assert.match(lines.at(-1), /esc/);
  }
});

test("preview reports bounded and expired output and scrolls inside its retained tail", () => {
  const params = fixture();
  const text = (changes) => stripAnsi(taskMonitorFrame({ ...params, ...changes }).lines.join("\n"));
  assert.match(text({}), /output-59/);
  assert.doesNotMatch(text({ previewOffset: 6 }), /output-59/);
  assert.match(text({ previewOffset: 6 }), /output-53/);
  assert.match(text({ previewOffset: 60 }), /Earlier output unavailable/);
  assert.match(text({ preview: { ...params.preview, limited: true } }), /Earlier output outside preview/);
  assert.match(text({ preview: { ...params.preview, expired: true } }), /Output expired; preview incomplete/);
});

test("formatting work stays bounded as background history grows", () => {
  for (const page of ["background"]) {
    for (const count of [100, 10000]) {
      const params = { ...fixture(count), page };
      let reads = 0;
      for (const item of params.items) Object.defineProperty(item, page === "background" ? "command" : "task", {
        get() { reads += 1; return "formatted"; },
      });
      taskMonitorFrame(params);
      assert.ok(reads <= 7, `${page}, ${count} tasks: ${reads} formatted details`);
    }
  }
});

test("monitor supports NO_COLOR and dims counts and helper separators", () => {
  const original = process.env.NO_COLOR;
  const originalTty = process.stdout.isTTY;
  try {
    process.stdout.isTTY = true;
    process.env.NO_COLOR = "1";
    const plain = taskMonitorFrame(fixture()).lines.join("\n");
    assert.doesNotMatch(plain, /\x1b\[/);
    delete process.env.NO_COLOR;
    const colored = taskMonitorFrame(fixture()).lines.join("\n");
    assert.match(colored, /\x1b\[2m\[100\]/);
    assert.match(colored, /\x1b\[2m[^\n]*·/);
  } finally {
    process.stdout.isTTY = originalTty;
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});
