import test from "node:test";
import assert from "node:assert/strict";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { createEventController } from "../lib/event-controller.js";
import { Container } from "../lib/tui/component.js";
import { createTourStage } from "../lib/tour/stage.js";
import { renderTourTranscript } from "../lib/tour/transcript.js";
import { graphemes, stripAnsi } from "../lib/text-width.js";

const INFO = { version: "0.8.0", model: "demo", session_id: "s1", cwd: "~/demo" };
const plain = (lines) => lines.map(stripAnsi);

function liveSession() {
  const transcript = new Container();
  const output = createCliOutputController({
    state: createCliState(), transcript, terminalUi: { requestRender() {} }, animateTools: false,
  });
  output.showStartup(INFO);
  const events = createEventController({ output });
  return { transcript, output, emit: (event) => events.handle({ method: "session/update", event }) };
}

function apply(stage, step) {
  stage.beginStep(step);
  stage.settleStep(step);
}

test("tour matches live turn events line for line, including every blank line", async () => {
  const live = liveSession();
  const stage = createTourStage();
  apply(stage, { kind: "startup", info: INFO });
  const compare = (label, expanded = false) => {
    for (const width of [36, 76, 116]) {
      assert.deepEqual(
        plain(renderTourTranscript(stage.snapshot().rind, width, expanded)),
        plain(live.transcript.render(width)),
        `${label} at ${width} columns`,
      );
    }
  };
  compare("startup");
  live.output.writeUserInput("Check the parser.\nThen add unicode tests.");
  apply(stage, { kind: "type", text: "Check the parser.\nThen add unicode tests." });
  apply(stage, { kind: "submit", mode: "send" });
  compare("user echo");

  const beforeTools = "I'll read the parser first.\n\nThen add coverage.";
  await live.emit({ type: "assistant_delta", text: beforeTools });
  live.output.closeAssistant();
  apply(stage, { kind: "assistant", text: beforeTools });
  compare("assistant paragraphs");

  const read = { kind: "tool", name: "read_file", detail: "src/parser.js", outcome: { status: "ok", output: "const x = 1;\n\nexport { x };", durationMs: 120 } };
  const readRequest = { tool_call_id: "read-1", tool_name: "read_file", arguments: { file_path: "src/parser.js" } };
  await live.emit({ type: "tool_requested", ...readRequest });
  stage.beginStep(read);
  compare("running tool after assistant");
  await live.emit({ type: "tool_result", ...readRequest, status: "completed", duration_ms: 120, result: JSON.stringify({ data: read.outcome.output }) });
  stage.settleStep(read);
  compare("completed tool");

  const fileChange = { lines: [{ kind: "added", text: 'test("unicode", checkUnicode);' }] };
  const edit = { kind: "tool", name: "edit_file", detail: "test/parser.js", outcome: { status: "ok", durationMs: 80, data: {}, fileChange } };
  const editRequest = { tool_call_id: "edit-1", tool_name: "edit_file", arguments: { file_path: "test/parser.js" } };
  await live.emit({ type: "tool_requested", ...editRequest });
  await live.emit({ type: "file_change", tool_call_id: "edit-1", ...fileChange });
  await live.emit({ type: "tool_result", ...editRequest, status: "completed", duration_ms: 80, result: JSON.stringify({ data: {} }) });
  apply(stage, edit);
  compare("adjacent tool blocks and edit diff");

  const reply = "## Results\n\n| Input | Cases |\n| --- | --- |\n| 中文 | 2 |\n\n```js\ncheckUnicode();\n\n// done\n```\n\nAll cases pass.";
  await live.emit({ type: "assistant_delta", text: reply });
  live.output.closeAssistant();
  apply(stage, { kind: "assistant", text: reply });
  compare("assistant after tools, table and code spacing");
  await live.emit({ type: "turn_completed", duration_ms: 3400 });
  apply(stage, { kind: "turn-done", durationMs: 3400, completed: 2, failed: 0 });
  compare("completion separator");
  live.output.setToolsExpanded(true);
  compare("expanded output", true);

  const lines = plain(live.transcript.render(76));
  for (const label of ["▷ You", "◁ Assistant", "read src/parser.js", "edit test/parser.js", "Worked for"]) {
    const index = lines.findIndex((line) => line.includes(label));
    assert.ok(index > 0, `${label} is present`);
    assert.equal(lines[index - 1], "", `${label} has the live CLI's blank separator`);
  }
});

test("unfinished table candidates and code fences stay streaming until the step completes", async () => {
  for (const prefix of ["| Input | Cases |\n", "```js", "First paragraph\n\nSecond", "Emoji 😀\n\n中文"]) {
    const live = liveSession();
    const stage = createTourStage();
    apply(stage, { kind: "startup", info: INFO });
    const step = { kind: "assistant", text: prefix };
    stage.beginStep(step);
    let sent = 0;
    while (sent < graphemes(prefix).length) {
      stage.tick();
      const reveal = stage.snapshot().rind.blocks.at(-1).reveal;
      await live.emit({ type: "assistant_delta", text: graphemes(prefix).slice(sent, reveal).join("") });
      sent = reveal;
      assert.deepEqual(plain(renderTourTranscript(stage.snapshot().rind, 76)), plain(live.transcript.render(76)), `streaming ${JSON.stringify(prefix)} at ${sent}`);
    }
    stage.settleStep(step);
    live.output.closeAssistant();
    assert.deepEqual(plain(renderTourTranscript(stage.snapshot().rind, 76)), plain(live.transcript.render(76)), `completed ${JSON.stringify(prefix)}`);
  }
});

test("repeated tour snapshots never start live tool tickers", (t) => {
  t.mock.method(globalThis, "setInterval", () => { throw new Error("tour started a tool ticker"); });
  const stage = createTourStage();
  apply(stage, { kind: "startup", info: INFO });
  stage.beginStep({ kind: "tool", name: "bash", detail: "npm test", outcome: { status: "ok", durationMs: 300, output: "passed" } });
  for (let i = 0; i < 5; i++) renderTourTranscript(stage.snapshot().rind, 76);
});
