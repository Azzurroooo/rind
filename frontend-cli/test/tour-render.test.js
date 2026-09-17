import test from "node:test";
import assert from "node:assert/strict";

import { renderTourCatalog, renderTourPage, renderTourHelp } from "../lib/tour/render.js";
import { TOUR_TOPICS, tourPages } from "../lib/tour/pages/index.js";
import { currentTheme, setTheme } from "../lib/theme.js";
import { createTourStage } from "../lib/tour/stage.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

const INFO = { version: "0.8.0", model: "zai/glm-4.7", session_id: "s1", cwd: "~/demo", reasoning_effort: "high" };

const TOPICS = [
  {
    id: "start",
    title: "Start",
    pages: [
      { id: "start.hello", title: "Your first turn", steps: [{ kind: "shell", command: "rind" }] },
      { id: "start.steer", title: "Steer and queue", steps: [{ kind: "shell", command: "rind" }] },
    ],
  },
  {
    id: "team",
    title: "Team",
    pages: [
      { id: "team.create", title: "Create a Team", steps: [{ kind: "shell", command: "rind" }] },
    ],
  },
];

function playPage(steps, { width = 80, frame = 3, elapsedMs = 2400, phase = "idle" } = {}) {
  const stage = createTourStage();
  for (const step of steps) {
    stage.beginStep(step);
    while (stage.tick());
    stage.settleStep(step);
  }
  const snapshot = stage.snapshot();
  return { snapshot, render: (w = width) => renderTourPage(snapshot, pageState(phase), w) };
}

function pageState(phase) {
  return {
    page: { id: "team.create", title: "Create a Team" },
    pageIndex: 2,
    pageCount: 16,
    stepIndex: 3,
    stepCount: 8,
    speed: 1,
    paused: false,
    phase,
    frame: 3,
    elapsedMs: 2400,
    topics: TOPICS,
    selected: 2,
  };
}

test("catalog groups pages under topics and marks the selection", () => {
  const { lines } = renderTourCatalog({ topics: TOPICS, selected: 2 }, 80);
  const plain = lines.map(stripAnsi);
  const text = plain.join("\n");
  assert.ok(text.includes("START"), "topic headers appear");
  assert.ok(text.includes("TEAM"), "topic headers appear");
  assert.ok(text.includes("start.hello"), "page ids appear");
  assert.ok(text.includes("Create a Team"), "page titles appear");
  const selectedRow = plain.find((line) => line.includes("team.create"));
  assert.ok(selectedRow.includes("›"), "selected page marked");
  const unselectedRow = plain.find((line) => line.includes("start.hello"));
  assert.ok(!unselectedRow.includes("›"), "unselected pages use the dim marker");
  const badge = plain.find((line) => line.includes("3/3"));
  assert.ok(badge, "selection badge shows position");
});

test("catalog rows and hints stay inside narrow terminals", () => {
  const { lines } = renderTourCatalog({ topics: TOPICS, selected: 0 }, 60);
  for (const line of lines) {
    assert.ok(textWidth(line) <= 60, `row too wide: ${stripAnsi(line)}`);
  }
});

test("page frame titles the page and wraps every content line", () => {
  const { render } = playPage([
    { kind: "startup", info: INFO },
    { kind: "type", text: "/team create" },
    { kind: "submit", mode: "send" },
    { kind: "result", text: "Team created", detail: ".aiteam ready" },
  ]);
  for (const width of [120, 80, 60]) {
    const { lines } = render(width);
    const plain = lines.map(stripAnsi);
    assert.ok(plain[0].includes("Tour"), "top border carries the Tour title");
    assert.ok(plain[0].includes("Create a Team"), "top border carries the page title");
    assert.ok(plain[0].includes("3/16"), "top border carries the page position");
    for (const line of lines) {
      assert.ok(textWidth(line) <= width, `row exceeds ${width}: ${stripAnsi(line)}`);
    }
    const text = plain.join("\n");
    assert.ok(text.includes("Rind v0.8.0"), "startup banner rendered");
    assert.ok(text.includes("zai/glm-4.7"), "model shown in banner");
    assert.ok(text.includes("You"), "user echo rendered");
    assert.ok(text.includes("/team create"), "submitted text rendered");
    assert.ok(text.includes("✓ Team created"), "result line rendered with the check prefix");
    assert.ok(text.includes("— .aiteam ready"), "result detail rendered");
    assert.ok(!text.includes("Working"), "a slash command never shows the activity line");
  }
});

test("shell typing shows a prompt line with a hardware cursor point", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "shell", command: "rind" });
  stage.tick();
  stage.tick();
  const { lines, cursor } = renderTourPage(stage.snapshot(), { ...pageState("idle"), page: { title: "T" } }, 80);
  const typed = lines.map(stripAnsi).find((line) => line.includes("$ ri"));
  assert.ok(typed, "partially typed command visible");
  // cursor column = frame prefix (2) + visible prompt "~/demo $ " (9) + "ri" (2)
  assert.equal(cursor.column, 13);
  assert.ok(cursor.line >= 1, "cursor sits below the top border");
});

test("idle composer exposes the placeholder and a cursor; running composer hides it", () => {
  const { snapshot } = playPage([
    { kind: "startup", info: INFO },
  ]);
  const idle = renderTourPage(snapshot, { ...pageState("idle"), page: { title: "T" } }, 80);
  assert.ok(idle.cursor, "idle composer pins the cursor");
  const idleText = idle.lines.map(stripAnsi).join("\n");
  assert.ok(idleText.includes("Ask Rind to do anything"), "placeholder visible");

  const running = playPage([
    { kind: "startup", info: INFO },
    { kind: "type", text: "go" },
    { kind: "submit", mode: "send" },
  ]);
  const runningView = running.render();
  assert.equal(runningView.cursor, null, "running composer has no cursor");
  assert.ok(runningView.lines.map(stripAnsi).join("\n").includes("ctrl+c interrupt"), "activity hint visible");
});

test("tool blocks flip from running to their result line", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
  stage.beginStep({ kind: "tool", name: "bash", detail: "npm test", outcome: { status: "ok", output: "all green", durationMs: 900 } });
  const runningText = renderTourPage(stage.snapshot(), { ...pageState("idle"), page: { title: "T" } }, 80)
    .lines.map(stripAnsi).join("\n");
  assert.ok(runningText.includes("◌") && runningText.includes("npm test"), "current CLI running tool shown");

  stage.settleStep({ kind: "tool", name: "bash", detail: "npm test", outcome: { status: "ok", output: "all green", durationMs: 900 } });
  stage.beginStep({ kind: "turn-done", durationMs: 4200, completed: 1, failed: 0 });
  stage.settleStep({ kind: "turn-done", durationMs: 4200, completed: 1, failed: 0 });
  const doneText = renderTourPage(stage.snapshot(), { ...pageState("idle"), page: { title: "T" } }, 80)
    .lines.map(stripAnsi).join("\n");
  assert.ok(doneText.includes("npm test"), "completed command retains its arguments");
  assert.ok(doneText.includes("all green"), "tool output shown");
  assert.ok(doneText.includes("Worked for"), "turn summary shown");
});

test("assistant markdown renders through the real message pipeline", () => {
  const { render } = playPage([
    { kind: "startup", info: INFO },
    { kind: "assistant", text: "## Heading\n\n- first item\n- second item" },
  ]);
  const text = render().lines.map(stripAnsi).join("\n");
  assert.ok(text.includes("Assistant"), "assistant header shown");
  assert.ok(text.includes("Heading"), "markdown heading rendered");
  assert.ok(text.includes("first item"), "list rendered");
});

test("caption notes render under the stage; end phase shows the outro", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "note", lines: ["Read this first", "it explains the flow"] });
  stage.settleStep({ kind: "note", lines: ["Read this first", "it explains the flow"] });
  const snapshot = stage.snapshot();
  const waiting = renderTourPage(snapshot, { ...pageState("waiting"), page: { title: "T" } }, 80);
  const waitingText = waiting.lines.map(stripAnsi).join("\n");
  assert.ok(waitingText.includes("Read this first"), "caption headline shown");
  assert.ok(waitingText.includes("it explains the flow"), "caption body shown");
  assert.ok(waitingText.includes("space continue"), "waiting hints shown");

  const end = renderTourPage(snapshot, { ...pageState("end"), page: { title: "Create a Team" } }, 80);
  const endText = end.lines.map(stripAnsi).join("\n");
  assert.ok(endText.includes("page complete"), "completion is explicit");
  assert.ok(endText.includes("Read this first"), "completion retains the learning takeaway");
  assert.ok(endText.includes("r replay"), "outro hints shown");
});

test("plain runtime outputs stay verbatim while check results get the prefix", () => {
  const view = playPage([
    { kind: "startup", info: INFO },
    { kind: "slash-result", text: "Team Agents:\n- main-agent | Main | Coordinates", detail: "", display: null },
    { kind: "result", text: "Team created", detail: ".aiteam ready" },
  ]);
  const text = view.render().lines.map(stripAnsi).join("\n");
  assert.ok(text.includes("Team Agents:"), "multi-line runtime output keeps its own lines");
  assert.ok(text.includes("✓ Team created — .aiteam ready"), "check result carries prefix and detail");
});

test("pending queue and steering entries appear in the composer", () => {
  const view = playPage([
    { kind: "startup", info: INFO },
    { kind: "type", text: "big task" },
    { kind: "submit", mode: "send" },
    { kind: "type", text: "run the tests after" },
    { kind: "submit", mode: "queue" },
    { kind: "type", text: "actually start with lint" },
    { kind: "submit", mode: "steer" },
  ]);
  const text = view.render().lines.map(stripAnsi).join("\n");
  assert.ok(text.includes("Queue:"), "queue entry visible");
  assert.ok(text.includes("Steering:"), "steering entry visible");
});

test("menu steps render through the real menu renderers", () => {
  const view = playPage([
    { kind: "startup", info: INFO },
    { kind: "menu", menu: { kind: "model", items: [{ header: true, name: "zai" }, { name: "glm-4.7", current: true }], selected: 0, target: 1, input: "/model" } },
  ]);
  const text = view.render().lines.map(stripAnsi).join("\n");
  assert.ok(text.includes("Model deck"), "model deck title shown");
  assert.ok(text.includes("glm-4.7"), "model item shown");
  assert.ok(text.includes("/model"), "menu input echo shown");
});

test("goodbye closes the session back to the shell prompt", () => {
  const view = playPage([
    { kind: "startup", info: INFO },
    { kind: "exit" },
    { kind: "shell", command: "ls" },
  ]);
  const text = view.render().lines.map(stripAnsi).join("\n");
  assert.ok(text.includes("Goodbye."), "goodbye line shown");
  assert.ok(text.includes("~/demo $ ls"), "shell prompt returned");
  assert.ok(!text.includes("Ask Rind to do anything"), "composer hidden after exit");
});

test("all lesson steps, contents and help fit supported terminal sizes", () => {
  for (const [width, height] of [[80, 24], [60, 20], [40, 16], [36, 14]]) {
    const fits = (out, label) => {
      assert.ok(out.lines.length <= height, `${label}: ${out.lines.length} rows > ${height}`);
      assert.ok(out.lines.every((line) => textWidth(line) <= width), `${label}: width > ${width}`);
      if (out.cursor) {
        assert.ok(out.cursor.line < out.lines.length);
        assert.ok(out.cursor.column < width);
      }
    };
    fits(renderTourHelp(width, height), "help");
    for (const [selected, page] of tourPages().entries()) {
      fits(renderTourCatalog({ topics: TOUR_TOPICS, selected }, width, height), page.id);
      const stage = createTourStage();
      for (const [index, step] of page.steps.entries()) {
        stage.beginStep(step);
        stage.settleStep(step);
        const state = { ...pageState("waiting"), page, stepIndex: index, stepCount: page.steps.length };
        const out = renderTourPage(stage.snapshot(), state, width, height);
        fits(out, `${page.id}:${index}`);
        assert.ok(out.lines.map(stripAnsi).join("\n").includes("space continue"));
      }
    }
  }
});

test("shell history stays in chronological order across exit and restart", () => {
  const page = tourPages().find((page) => page.id === "team.create");
  const stage = createTourStage();
  stage.rebuildTo(page.steps, page.steps.length - 1);
  const text = renderTourPage(stage.snapshot(), { ...pageState("end"), page }, 100).lines.map(stripAnsi).join("\n");
  assert.ok(text.indexOf("Goodbye.") < text.indexOf("$ ls .aiteam/agents"));
  assert.ok(text.indexOf("$ ls .aiteam/agents") < text.indexOf("$ cd .aiteam/agents/main-agent"));
  assert.ok(text.includes("~/demo/.aiteam/agents/main-agent $ rind"));
});

test("wrapped shell cursor remains on the command and scrollback exposes earlier rows", () => {
  const stage = createTourStage();
  stage.beginStep({ kind: "shell", command: "1234567890".repeat(10) });
  for (let i = 0; i < 45; i++) stage.tick();
  const out = renderTourPage(stage.snapshot(), pageState("anim"), 40, 20);
  assert.ok(stripAnsi(out.lines[out.cursor.line]).includes("5"));
  assert.equal(out.cursor.column, 11, "cursor follows the last wrapped digit, after the frame inset");
  const page = tourPages().find((page) => page.id === "start.hello");
  stage.rebuildTo(page.steps, page.steps.length - 1);
  const bottom = renderTourPage(stage.snapshot(), { ...pageState("end"), page }, 80, 24);
  const top = renderTourPage(stage.snapshot(), { ...pageState("end"), page, scrollOffset: bottom.maxScroll }, 80, 24);
  assert.ok(top.lines.map(stripAnsi).join("\n").includes("Rind v"));
  assert.ok(top.lines.map(stripAnsi).join("\n").includes("Try it:"), "takeaway stays visible while scrolling");
});

test("theme preview restores the user's theme and NO_COLOR is respected", () => {
  const previous = currentTheme().name;
  const priorNoColor = process.env.NO_COLOR;
  setTheme("frappe");
  process.env.NO_COLOR = "1";
  try {
    const page = tourPages().find((page) => page.id === "model.theme");
    const stage = createTourStage();
    stage.rebuildTo(page.steps, page.steps.length - 1);
    const out = renderTourPage(stage.snapshot(), { ...pageState("end"), page }, 80, 24);
    assert.equal(currentTheme().name, "frappe");
    assert.ok(out.lines.every((line) => line === stripAnsi(line)));
  } finally {
    setTheme(previous);
    if (priorNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = priorNoColor;
  }
});
