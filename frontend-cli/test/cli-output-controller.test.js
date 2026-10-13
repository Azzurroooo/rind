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

test("replayed history shows deliveries as reports and still-waiting work as waiting", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  const delegateResult = JSON.stringify({ ok: true, tool: "delegate", data: { taskId: "8f21ab77c3", assignee: "reviewer", next: "End your turn now." } });
  output.renderHistory([
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "delegate", arguments: '{"to":"reviewer","brief":"Check Unicode"}' } }] },
    { role: "tool", tool_call_id: "c1", content: delegateResult },
    { role: "user", content: "Delegated work settled:\n- reviewer · task 8f21ab77c3 · delivered: done\n  Summary: Reviewed.", _rind_meta: { kind: "team_delivery" } },
    { role: "assistant", content: "Reviewed the delivery." },
  ], {});
  const lines = stripAnsi(transcript.render(100).join("\n"));
  assert.match(lines, /delegate → reviewer · task 8f21ab77c3/);
  assert.match(lines, /─ Delivery/);
  assert.match(lines, /Delegated work settled:/);
  assert.doesNotMatch(lines, /▷ You/, "a delivery is not shown as a user message");

  const waiting = createTranscript();
  const waitingOut = createCliOutputController({ state: createCliState(), transcript: waiting, terminalUi: { requestRender() {} }, animateTools: false });
  waitingOut.renderHistory([
    { role: "assistant", content: "", tool_calls: [{ id: "c2", function: { name: "delegate", arguments: '{"to":"reviewer","brief":"Check Unicode"}' } }] },
    { role: "tool", tool_call_id: "c2", content: delegateResult },
  ], {});
  assert.match(stripAnsi(waiting.render(100).join("\n")), /─ Waiting for reviewer/);
});
