import assert from "node:assert/strict";
import test from "node:test";
import { createCliState } from "../lib/cli-state.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createTranscript } from "../lib/tui/transcript.js";
import { stripAnsi } from "../lib/text-width.js";
import { createEventController } from "../lib/event-controller.js";

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

test("restored delegations survive ordinary turns, settle by heading, and clear on cancellation", async () => {
  const state = createCliState();
  state.session.info.session_id = "leader";
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  const result = taskId => JSON.stringify({ ok: true, data: { taskId, assignee: taskId } });
  // Construct the event controller first, as the actual CLI does before replay.
  const lines = [];
  const events = createEventController({ state: { sessionInfo: state.session.info, pendingDelegations: state.display.pendingDelegations },
    output: { log: line => lines.push(typeof line === "function" ? line() : line) } });
  output.renderHistory(["a", "b"].flatMap(taskId => [
    { role: "assistant", tool_calls: [{ id: taskId, function: { name: "delegate", arguments: "{}" } }] },
    { role: "tool", tool_call_id: taskId, content: result(taskId) },
  ]));
  await events.handle({ event: { type: "turn_completed", session_id: "leader" } });
  assert.match(lines.at(-1), /Waiting for a, b/);
  await events.handle({ event: { type: "turn_started", session_id: "leader", delivery: true,
    delivery_text: "Delegated work settled:\n- a · task a · delivered: complete\n  Summary: Also reviewed task b." } });
  assert.deepEqual([...state.display.pendingDelegations.keys()], ["b"], "evidence mentioning b does not settle b");
  await events.handle({ event: { type: "tool_result", session_id: "leader", tool_name: "delegate", status: "completed",
    result: JSON.stringify({ ok: true, data: { taskId: "b", status: "cancelled" } }) } });
  await events.handle({ event: { type: "turn_completed", session_id: "leader" } });
  assert.equal(state.display.pendingDelegations.size, 0);
  assert.match(lines.at(-1), /Worked for/);
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

test("management restores pending work outside the tail and removes settled replay entries", () => {
  const state = createCliState();
  const transcript = createTranscript();
  const output = createCliOutputController({ state, transcript, terminalUi: { requestRender() {} }, animateTools: false });
  output.renderHistory([{ role: "assistant", content: "recent reply" }], {
    pendingDelegations: [{ taskId: "old-task", assignee: "reviewer", sessionId: "leader" }],
  });
  assert.deepEqual([...state.display.pendingDelegations.keys()], ["old-task"]);
  assert.match(stripAnsi(transcript.render(100).join("\n")), /Waiting for reviewer/);
  output.renderHistory([
    { role: "assistant", tool_calls: [{ id: "c", function: { name: "delegate" } }] },
    { role: "tool", tool_call_id: "c", content: JSON.stringify({ ok: true, data: { taskId: "settled" } }) },
  ], { pendingDelegations: [] });
  assert.equal(state.display.pendingDelegations.size, 0);
});
