import { describe, expect, it } from "vitest";
import { conversationView, emptyConversationState, reduceConversation, TOOL_PROGRESS_CAP } from "./conversationReducer.js";

let sequence = 0;
function envelope(event, extra = {}) {
  sequence += 1;
  return { kind: "event", method: "session/update", sequence, durability: "ephemeral", session_id: "s1", turn_id: "t1", event, ...extra };
}

function run(events, start = emptyConversationState()) {
  return events.reduce((state, event) => reduceConversation(state, envelope(event)), start);
}

const toolOf = (state, id = "c1") => state.entries.find((entry) => entry.role === "tool" && entry.tool_call_id === id);

it("restores compact operation from live replay and clears it on completion", () => {
  const state = reduceConversation(emptyConversationState(), { kind: "live_turn", sessionId: "s1", liveTurn: { turn_id: "c1", status: "running", operation: "compact" } });
  expect(state.operation).toBe("compact");
  expect(run([{ type: "turn_completed" }], state).operation).toBe("");
});

it("reflects an answer submitted on another surface before the turn ends", () => {
  const state = run([
    { type: "turn_started" },
    { type: "user_question_requested", tool_call_id: "q1", question: "Which scope?", options: [] },
    { type: "tool_result", tool_call_id: "q1", tool_name: "ask_user_question", result: JSON.stringify({ ok: true, data: { answer: "Focused" } }) },
  ]);
  expect(state.question).toBeNull();
  expect(state.entries.find(item => item.role === "question")).toMatchObject({ status: "answered", selectedAnswer: "Focused" });
});

describe("conversation reducer — v2 tool input streaming", () => {
  it("creates a running row on tool_input_started and accumulates deltas as the args preview", () => {
    const state = run([
      { type: "turn_started" },
      { type: "tool_input_started", tool_call_id: "c1", tool_name: "write_file" },
      { type: "tool_input_delta", tool_call_id: "c1", tool_name: "write_file", delta: "{\"path\":" },
      { type: "tool_input_delta", tool_call_id: "c1", tool_name: "write_file", delta: "\"a.txt\"}" },
    ]);
    expect(toolOf(state)).toMatchObject({ name: "write_file", status: "running", inputStreaming: true, args: "{\"path\":\"a.txt\"}" });
  });

  it("ends streaming on tool_input_ended and keeps the accumulated args when tool_requested has no preview", () => {
    const state = run([
      { type: "tool_input_started", tool_call_id: "c1", tool_name: "shell" },
      { type: "tool_input_delta", tool_call_id: "c1", delta: "{\"cmd\":\"ls\"}" },
      { type: "tool_input_ended", tool_call_id: "c1", tool_name: "shell" },
      { type: "tool_requested", tool_call_id: "c1", tool_name: "shell" },
    ]);
    expect(toolOf(state)).toMatchObject({ inputStreaming: false, args: "{\"cmd\":\"ls\"}", status: "running" });
  });

  it("lets a later args_preview replace the streamed args", () => {
    const state = run([
      { type: "tool_input_delta", tool_call_id: "c1", delta: "{\"cmd\"" },
      { type: "tool_requested", tool_call_id: "c1", tool_name: "shell", args_preview: "{\"cmd\":\"pwd\"}" },
    ]);
    expect(toolOf(state).args).toBe("{\"cmd\":\"pwd\"}");
  });

  it("is running only until its own result arrives", () => {
    const state = run([
      { type: "tool_requested", tool_call_id: "c1", tool_name: "a" },
      { type: "tool_requested", tool_call_id: "c2", tool_name: "b" },
      { type: "tool_result", tool_call_id: "c1", status: "completed", result: "ok" },
    ]);
    expect(toolOf(state, "c1").status).toBe("completed");
    expect(toolOf(state, "c2").status).toBe("running");
  });
});

describe("conversation reducer — tool_progress", () => {
  it("appends progress lines from message, status or text", () => {
    const state = run([
      { type: "tool_requested", tool_call_id: "c1", tool_name: "fetch" },
      { type: "tool_progress", tool_call_id: "c1", payload: { message: "connecting" } },
      { type: "tool_progress", tool_call_id: "c1", payload: { status: "downloading" } },
      { type: "tool_progress", tool_call_id: "c1", payload: { text: "done" } },
      { type: "tool_progress", tool_call_id: "c1", payload: {} },
    ]);
    expect(toolOf(state).progress).toEqual(["connecting", "downloading", "done"]);
  });

  it("caps progress lines, dropping the oldest", () => {
    const events = [{ type: "tool_requested", tool_call_id: "c1", tool_name: "x" }];
    for (let index = 0; index < TOOL_PROGRESS_CAP + 5; index += 1) {
      events.push({ type: "tool_progress", tool_call_id: "c1", payload: { message: `line ${index}` } });
    }
    const progress = toolOf(run(events)).progress;
    expect(progress).toHaveLength(TOOL_PROGRESS_CAP);
    expect(progress[0]).toBe("line 5");
  });
});

describe("conversation reducer — retry, compaction and background wait", () => {
  it("clears streaming text on turn_step_retry and adds a notice line", () => {
    const state = run([
      { type: "turn_started" },
      { type: "assistant_delta", text: "partial" },
      { type: "turn_step_retry", attempt: 2, reason: "rate limited" },
    ]);
    expect(conversationView(state).draft).toBe("");
    expect(state.entries.at(-1)).toMatchObject({ role: "system", tone: "notice", content: "Retrying step · attempt 2 · rate limited" });
  });

  it("renders context_compacted as a notice with its reason", () => {
    const state = run([{ type: "context_compacted", record: { reason: "threshold" } }]);
    expect(state.entries.at(-1)).toMatchObject({ role: "system", tone: "notice", content: "Context compacted · threshold" });
  });

  it("tracks background_wait_changed and clears it on null and at turn end", () => {
    const waiting = run([
      { type: "turn_started" },
      { type: "background_wait_changed", background_wait: { count: 2, started_at: 100 } },
    ]);
    expect(conversationView(waiting).backgroundWait).toEqual({ count: 2, startedAt: 100 });
    expect(run([{ type: "background_wait_changed", background_wait: null }], waiting).backgroundWait).toBeNull();
    expect(run([{ type: "turn_completed" }], waiting).backgroundWait).toBeNull();
  });
});
