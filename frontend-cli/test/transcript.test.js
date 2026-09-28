import assert from "node:assert/strict";
import test from "node:test";
import { createTranscript } from "../lib/tui/transcript.js";
import { renderFrame, CURSOR_MARKER } from "../lib/tui/frame.js";
import { AssistantMessage } from "../lib/components/assistant-message.js";

test("status frames do not render or normalize stable transcript history", () => {
  const transcript = createTranscript();
  let renders = 0;
  for (let i = 0; i < 4000; i++) transcript.addChild({ render() { renders++; return ["history"]; } });
  let text = "a";
  const children = [transcript, { render: () => [`${text}${CURSOR_MARKER}`] }];
  const first = renderFrame(children, 80);
  assert.equal(renders, 4000);
  text = "中文";
  const next = renderFrame(children, 80, first.segments);
  assert.equal(renders, 4000);
  assert.equal(next.unchangedPrefix, 4000);
  assert.deepEqual(next.cursor, { row: 4000, col: 4 });
  assert.equal(next.at(4000), "中文");
  assert.equal(first.at(4000), "a");
  transcript.changed();
  renderFrame(children, 80, next.segments);
  assert.equal(renders, 8000);
  transcript.clear();
  assert.equal(renderFrame(children, 80).length, 1);
});

test("unfrozen arrays remain compatible and changed layouts compare from the right offset", () => {
  const mutable = ["old"];
  const stable = Object.freeze(["stable"]);
  const children = [{ render: () => mutable }, { render: () => stable }];
  const first = renderFrame(children, 80);
  mutable[0] = "new";
  mutable.push("added");
  const next = renderFrame(children, 80, first.segments);
  assert.equal(next.unchangedPrefix, 0);
  assert.equal(next.at(2), "stable");
  assert.equal(first.at(0), "old");
});

test("unchanged streaming Markdown tails are cached until content or width changes", (t) => {
  const message = new AssistantMessage();
  const wrap = t.mock.method(message, "wrapLogical");
  message.append("**pending**");
  const lines = message.render(80);
  message.render(80);
  assert.equal(wrap.mock.callCount(), 1);
  message.append(" more");
  assert.notDeepEqual(message.render(80), lines);
  message.render(5);
  assert.ok(wrap.mock.callCount() > 2);
});
