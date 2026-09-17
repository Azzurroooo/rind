import assert from "node:assert/strict";
import test from "node:test";
import { promptText, startupText } from "../lib/rendering.js";
import { textWidth, stripAnsi } from "../lib/text-width.js";
import { resetTheme, setTheme } from "../lib/theme.js";

const info = {
  version: "1.0",
  model: "test-model",
  reasoning_effort: "high",
  cwd: "E:/project/agents/coordinator",
  team_main: { agent_id: "coordinator", project_name: "研究项目" },
};

test("Team identity appears in the banner and persists in the idle composer", () => {
  const banner = startupText(info, 80);
  assert.match(banner, /Rind v1.0  \[TEAM\]/);
  assert.match(banner, /coordinator · 研究项目/);
  assert.equal(banner.split("\n").length, 6);
  assert.equal(promptText(info, {}, {}, 80).split("\n")[1],
    "  [TEAM] test-model · high · E:/project/agents/coordinator");
  const ordinary = { ...info, team_main: null };
  assert.doesNotMatch(startupText(ordinary), /TEAM|研究项目/);
  assert.doesNotMatch(promptText(ordinary), /TEAM/);
  assert.equal(startupText(ordinary).split("\n").length, 5);
});

test("Team header fits narrow widths with long CJK fields and task counts", () => {
  const long = {
    ...info,
    model: "模型".repeat(30),
    cwd: `E:/${"工作目录/".repeat(20)}coordinator`,
    background_count: 2,
    delegate_count: 1,
    team_main: { agent_id: "coordinator", project_name: "研究项目".repeat(30) },
  };
  for (const width of [10, 16, 24, 40, 60, 80, 120]) {
    const header = promptText(long, {}, {}, width).split("\n")[1];
    assert.ok(header.startsWith("  [TEAM]"), header);
    assert.ok(textWidth(header) <= width - 2, header);
    assert.ok(startupText(long, width).split("\n").every((line) => textWidth(line) <= width));
  }
  const header = promptText(long, {}, {}, 80).split("\n")[1];
  assert.match(header, /\[bg:2\] \[delegate:1\]/);
  const pathHeader = promptText({ ...long, model: "m1", background_count: 0, delegate_count: 0 }, {}, {}, 60).split("\n")[1];
  assert.match(pathHeader, /\.\.\..*coordinator$/);
});

test("Team badge follows the theme and keeps its identity with NO_COLOR", () => {
  const tty = process.stdout.isTTY;
  const noColor = process.env.NO_COLOR;
  process.stdout.isTTY = true;
  delete process.env.NO_COLOR;
  try {
    for (const [theme, color] of [["mocha", "203;166;247"], ["latte", "136;57;239"]]) {
      setTheme(theme);
      for (const output of [startupText(info, 80), promptText(info, {}, {}, 80)]) {
        assert.ok(output.includes(`\x1b[1m\x1b[38;2;${color}m[TEAM]`));
      }
    }
    process.env.NO_COLOR = "1";
    for (const output of [startupText(info, 80), promptText(info, {}, {}, 80)]) {
      assert.equal(output, stripAnsi(output));
      assert.match(output, /\[TEAM\]/);
    }
  } finally {
    resetTheme();
    process.stdout.isTTY = tty;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});
