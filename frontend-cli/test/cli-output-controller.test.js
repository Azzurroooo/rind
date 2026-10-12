import assert from "node:assert/strict";
import test from "node:test";
import { createCliState } from "../lib/cli-state.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createTranscript } from "../lib/tui/transcript.js";
import { stripAnsi } from "../lib/text-width.js";

test("clearing the transcript drops every block, and the next one starts at the top", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  output.log("old conversation");
  output.beginTool({ tool_call_id: "c1", tool_name: "bash", args_preview: "{}" });
  output.assistantAppend("partial");
  output.clearTranscript();
  assert.equal(transcript.length, 0);
  output.log("new conversation");
  assert.match(stripAnsi(transcript.render(40)[0]), /new conversation/, "no blank line above the first block");
  output.finishTool({ tool_call_id: "c1", tool_name: "bash", status: "completed", result: "" });
  assert.ok(transcript.length > 1, "a call from the old conversation is not found again");
});
