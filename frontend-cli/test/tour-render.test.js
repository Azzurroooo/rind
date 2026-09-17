import test from "node:test";
import assert from "node:assert/strict";

import { renderTourCatalog, renderTourPage, renderTourHelp } from "../lib/tour/render.js";
import { TOUR_TOPICS, tourPages } from "../lib/tour/pages/index.js";
import { currentTheme, setTheme, paintRaw } from "../lib/theme.js";
import { createTourStage } from "../lib/tour/stage.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

const INFO = { version: "0.8.0", model: "zai/glm-4.7", session_id: "s1", cwd: "~/demo", reasoning_effort: "high" };

const TOPICS = [
  {
    id: "start",
    title: "Start",
    pages: [
      { id: "start.hello", feature: "rind", title: "Your first turn", steps: [{ kind: "shell", command: "rind" }] },
      { id: "start.steer", feature: "Enter / Tab", title: "Steer and queue", steps: [{ kind: "shell", command: "rind" }] },
    ],
  },
  {
    id: "team",
    title: "Team",
    pages: [
      { id: "team.create", feature: "/team create", title: "Create a Team", steps: [{ kind: "shell", command: "rind" }] },
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
  assert.ok(text.includes("Enter / Tab"), "feature names appear");
  assert.ok(text.includes("Create a Team"), "page titles appear");
  const selectedRow = plain.find((line) => line.includes("/team create"));
  assert.ok(selectedRow.includes("›"), "selected page marked");
  const unselectedRow = plain.find((line) => line.includes("Your first turn"));
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
    assert.ok(plain[0].includes("Demo"), "top border identifies the simulated terminal");
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
  stage.beginStep({ kind: "startup", info: INFO });
  stage.settleStep({ kind: "startup", info: INFO });
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
  assert.ok(endText.includes("COMPLETE"), "completion is explicit");
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
        assert.match(out.lines.map(stripAnsi).join("\n"), /space continue|READY · Enter \/ Space to start/);
      }
    }
  }
});

test("shell history stays in chronological order across exit and restart", () => {
  const page = tourPages().find((page) => page.id === "team.create");
  const stage = createTourStage();
  stage.rebuildTo(page.steps, page.steps.length - 1);
  const text = renderTourPage(stage.snapshot(), { ...pageState("end"), page }, 100).lines.map(stripAnsi).join("\n");
  assert.ok(text.indexOf("Goodbye.") < text.indexOf("$ ls agents"));
  assert.ok(text.indexOf("$ ls agents") < text.indexOf("$ cd agents/main-agent"));
  assert.ok(text.includes("~/demo/agents/main-agent $ rind"));
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

test("explanation, manual pause, automatic hold and playback have distinct visible states", () => {
  const stage = createTourStage();
  stage.rebuildTo([{ kind: "startup", info: INFO }, { kind: "note", lines: ["Watch what happens next."] }], 1);
  const cases = [
    [{ phase: "waiting" }, "PAUSED · Read this explanation", "space continue"],
    [{ phase: "after", paused: true }, "PAUSED · You paused playback", "space resume"],
    [{ phase: "after", paused: true, pauseReason: "review" }, "PAUSED · Reviewing this step", "space resume"],
    [{ phase: "after", remainingMs: 2340 }, "AUTO · next step in 2.4s", "enter next now"],
    [{ phase: "anim" }, "PLAYING", "enter skip"],
    [{ phase: "end" }, "COMPLETE", "enter next page"],
  ];
  for (const [changes, label, action] of cases) {
    for (const width of [36, 80]) {
      const state = { ...pageState("waiting"), stepIndex: 6, stepCount: 20, ...changes };
      const out = renderTourPage(stage.snapshot(), state, width, 14);
      const plain = out.lines.map(stripAnsi).join("\n");
      assert.ok(plain.includes(label), plain);
      assert.ok(plain.includes(action), plain);
      assert.ok(plain.includes("Step 7/20"), "step number comes before speed and help");
      assert.match(plain, /\[[━·]+\]/, "progress has a visible track");
      assert.ok(out.lines.length <= 14);
      if (changes.paused || changes.phase === "waiting") assert.ok(!plain.includes("next step in"));
    }
  }
});

test("all guidance is outside the closed simulated terminal, even without color", () => {
  const stage = createTourStage();
  stage.rebuildTo([
    { kind: "startup", info: INFO },
    { kind: "note", lines: ["GUIDANCE: read this explanation."] },
  ], 1);
  for (const phase of ["waiting", "after", "anim", "end"]) {
    for (const [width, height] of [[80, 24], [36, 14]]) {
      const view = renderTourPage(stage.snapshot(), { ...pageState(phase), remainingMs: 1200 }, width, height);
      const lines = plainLines(view.lines);
      const border = lines.findIndex((line) => /^└─+┘$/.test(line));
      const guide = lines.findIndex((line) => line.includes("TOUR GUIDE"));
      assert.ok(border >= 0 && guide > border, "the demo closes before the separate guide begins");
      assert.ok(lines.findIndex((line) => /PAUSED|AUTO|PLAYING|COMPLETE/.test(line)) > guide);
      assert.ok(lines.findIndex((line) => line.includes("GUIDANCE:")) > guide);
      assert.ok(lines.findIndex((line) => line.includes("Step ")) > guide);
      assert.ok(!lines.slice(0, border).some((line) => /PAUSED|COMPLETE|GUIDANCE/.test(line)));
      if (view.cursor) assert.ok(view.cursor.line < border, "cursor remains inside the demo");
    }
  }
});

test("pause uses the pause pictograph and danger color rather than Roman numerals", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  const stage = createTourStage();
  stage.rebuildTo([{ kind: "startup", info: INFO }], 0);
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    delete process.env.NO_COLOR;
    const lines = renderTourPage(stage.snapshot(), pageState("waiting"), 80, 24).lines;
    const banner = lines.find((line) => line.includes("PAUSED"));
    assert.ok(stripAnsi(banner).startsWith("⏸ PAUSED"));
    assert.ok(!banner.includes("Ⅱ"));
    assert.ok(banner.startsWith(paintRaw.danger("marker").split("marker")[0]), "pause is red in the active theme");
    process.env.NO_COLOR = "1";
    const monochrome = renderTourPage(stage.snapshot(), pageState("waiting"), 80, 24).lines;
    assert.ok(monochrome.some((line) => line.startsWith("⏸ PAUSED")));
    assert.ok(monochrome.every((line) => line === stripAnsi(line)));
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete process.stdout.isTTY;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});

function plainLines(lines) {
  return lines.map(stripAnsi);
}

test("every lesson opens with a populated introduction card and a start action", () => {
  const noColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    for (const page of tourPages()) {
      const stage = createTourStage();
      stage.rebuildTo(page.steps, 0);
      for (const [width, height] of [[120, 30], [80, 24], [40, 16], [36, 14]]) {
        const state = { ...pageState("waiting"), page, stepIndex: 0, stepCount: page.steps.length };
        const view = renderTourPage(stage.snapshot(), state, width, height);
        const lines = view.lines;
        const text = lines.join("\n");
        assert.ok(lines[0].startsWith("┌─ TOUR ·"), page.id);
        assert.doesNotMatch(text, /Demo ·|TOUR GUIDE|PAUSED|AUTO|1×|\[[━·]+\]/);
        const border = lines.findIndex((line) => /^└─+┘$/.test(line));
        const ready = lines.findIndex((line) => line.includes("READY · Enter / Space to start"));
        assert.ok(ready > 1 && ready < border, "the start action belongs inside the card");
        const body = lines.slice(1, ready).map((line) => line.slice(1, -1).trim()).join(" ").replace(/\s+/g, " ");
        assert.ok(body.includes(stage.snapshot().caption.join(" ")), `${page.id} at ${width}: introduction is readable in full`);
        assert.ok(lines.at(-1).startsWith(`Step 1/${page.steps.length}`));
        assert.ok(lines.length <= height && lines.every((line) => textWidth(line) <= width));
        assert.ok(lines.every((line) => line === stripAnsi(line)));
        assert.equal(view.cursor, null);
        assert.equal(view.maxScroll, 0, "authored introductions need no scrolling");
      }
    }
  } finally {
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});

test("introduction layout depends on visible content rather than step position", () => {
  const stage = createTourStage();
  const state = { ...pageState("waiting"), stepIndex: 2 };
  stage.rebuildTo([
    { kind: "note", lines: ["First introduction."] },
    { kind: "shell-out", lines: ["", "   "] },
    { kind: "note", lines: ["A second introduction."] },
  ], 2);
  const card = plainLines(renderTourPage(stage.snapshot(), state, 80, 24).lines).join("\n");
  assert.match(card, /TOUR ·/);
  assert.match(card, /A second introduction/);
  assert.match(card, /READY/);
  assert.match(card, /Step 3\/8/);

  stage.beginStep({ kind: "shell", command: "rind" });
  const demo = renderTourPage(stage.snapshot(), { ...state, stepIndex: 0, phase: "anim" }, 80, 24);
  assert.match(plainLines(demo.lines).join("\n"), /Demo ·/);
  assert.ok(demo.cursor, "even an empty shell prompt is real demo content");

  stage.rebuildTo([
    { kind: "startup", info: INFO },
    { kind: "exit" },
    { kind: "shell", command: "rind" },
    { kind: "note", lines: ["Session ended; review the transcript."] },
  ], 3);
  const history = stage.snapshot();
  history.shell = { blocks: [], typing: null };
  const retained = plainLines(renderTourPage(history, state, 80, 24).lines).join("\n");
  assert.match(retained, /Demo ·/);
  assert.match(retained, /Goodbye/);
  assert.match(retained, /PAUSED · Read this explanation/);
});

test("long introduction cards scroll from the top while keeping the start action visible", () => {
  const stage = createTourStage();
  stage.rebuildTo([{ kind: "note", lines: ["First instruction. " + "Read this carefully. ".repeat(45) + "Last instruction."] }], 0);
  const state = pageState("waiting");
  const top = renderTourPage(stage.snapshot(), state, 36, 14);
  const bottom = renderTourPage(stage.snapshot(), { ...state, scrollOffset: 0, paused: true }, 36, 14);
  assert.ok(top.maxScroll > 0);
  assert.equal(top.offset, top.maxScroll);
  assert.match(plainLines(top.lines).join("\n"), /First instruction/);
  assert.match(plainLines(bottom.lines).map((line) => line.replaceAll("│", "").trim()).join(" ").replace(/\s+/g, " "), /Last instruction/);
  for (const view of [top, bottom]) {
    const text = plainLines(view.lines).join("\n");
    assert.match(text, /READY · Enter \/ Space to start/);
    assert.match(text, /PgUp\/PgDn/);
    assert.doesNotMatch(text, /PAUSED/);
    assert.ok(view.lines.length <= 14 && view.lines.every((line) => textWidth(line) <= 36));
  }
});

test("catalog, introduction and demo preserve the same full feature name at every supported width", () => {
  for (const [selected, page] of tourPages().entries()) {
    for (const [width, height] of [[120, 30], [80, 24], [40, 16], [36, 14]]) {
      const catalog = plainLines(renderTourCatalog({ topics: TOUR_TOPICS, selected }, width, height).lines);
      const selectedRow = catalog.find((line) => line.includes("›"));
      assert.ok(selectedRow.includes(page.feature), `${page.id}: catalog must retain ${page.feature} at ${width}`);
      const stage = createTourStage();
      for (const [stepIndex, phase] of [[0, "waiting"], [1, "anim"], [page.steps.length - 1, "end"]]) {
        stage.rebuildTo(page.steps, stepIndex);
        const state = { ...pageState(phase), page, pageIndex: selected, stepIndex, stepCount: page.steps.length };
        const view = renderTourPage(stage.snapshot(), state, width, height);
        const title = stripAnsi(view.lines[0]);
        assert.ok(title.includes(`${stepIndex === 0 ? "TOUR" : "Demo"} · ${page.feature}`), `${page.id} at ${width}: ${title}`);
        assert.ok(title.includes(`${selected + 1}/16`), "catalog position remains visible too");
        assert.ok(textWidth(title) <= width);
        if (width === 80 && stepIndex === 0) {
          assert.ok(plainLines(view.lines).join("\n").includes(page.title), "introduction retains the descriptive subtitle");
        }
      }
    }
  }
});
