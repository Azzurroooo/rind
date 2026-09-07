import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationView, emptyConversationState, normalizeHistoryMessages, questionKey, reduceConversation } from "./conversationReducer.js";

// Golden fixture lives outside frontend-web: ../test/fixtures/ relative to here.
const FIXTURE_PATH = resolve(process.cwd(), "../test/fixtures/runtime_protocol.golden.jsonl");

function loadGoldenEnvelopes() {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((message) => message.kind === "event");
}

function replay(envelopes) {
  return envelopes.reduce((state, envelope) => reduceConversation(state, envelope), emptyConversationState());
}

describe("conversation reducer — golden replay (web-ui.md §3)", () => {
  const envelopes = loadGoldenEnvelopes();

  it("fixture contains the five expected session/update envelopes", () => {
    expect(envelopes).toHaveLength(5);
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rebuilds the final UI state from the golden stream", () => {
    const state = replay(envelopes);

    // Final UI state snapshot: message count, tool block, turn/card state.
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      name: "read_file",
      status: "completed",
    });
    expect(state.entries[1]).toMatchObject({ role: "assistant", content: "hello" });

    expect(state.active).toBe(false);
    expect(state.activeTurnId).toBe("");
    expect(state.streaming).toBeNull();
    expect(state.plan).toEqual([]);
    expect(state.question).toBeNull();
  });

  it("counts only durable envelopes toward the local cursor", () => {
    const state = replay(envelopes);
    // seq 2 (assistant_delta) is incremental → cursor is 4, not 5.
    expect(state.cursor).toBe(4);
  });

  it("is idempotent: replaying the same envelopes again changes nothing", () => {
    const once = replay(envelopes);
    const twice = envelopes.reduce((state, envelope) => reduceConversation(state, envelope), once);
    expect(twice).toEqual(once);
    expect(twice.entries).toHaveLength(2);
    expect(twice.cursor).toBe(4);
  });

  it("view mapping exposes the same stream as messages/draft/plan/active", () => {
    const view = conversationView(replay(envelopes));
    expect(view.messages).toHaveLength(2);
    expect(view.draft).toBe("");
    expect(view.active).toBe(false);
    expect(view.cursor).toBe(4);
  });
});

describe("conversation reducer — streaming aggregation", () => {
  it("aggregates assistant deltas per turn and finalizes on completion", () => {
    const envelopes = [
      event(1, "durable", { type: "turn_started", turn_id: "t1" }),
      event(2, "incremental", { type: "assistant_delta", turn_id: "t1", text: "hel" }),
      event(3, "incremental", { type: "assistant_delta", turn_id: "t1", text: "lo" }),
    ];
    let state = replay(envelopes);
    expect(state.streaming).toEqual({ turnId: "t1", text: "hello" });
    expect(conversationView(state).draft).toBe("hello");

    state = reduceConversation(state, event(4, "durable", { type: "assistant_message_completed", turn_id: "t1", content: "hello world" }));
    expect(state.entries).toEqual([expect.objectContaining({ role: "assistant", content: "hello world" })]);
    expect(state.streaming).toBeNull();
    expect(state.cursor).toBe(2);
  });

  it("flushes accumulated streaming text when a turn completes without content", () => {
    let state = replay([
      event(1, "durable", { type: "turn_started", turn_id: "t1" }),
      event(2, "incremental", { type: "assistant_delta", turn_id: "t1", text: "partial answer" }),
      event(3, "durable", { type: "turn_completed", turn_id: "t1" }),
    ]);
    expect(state.entries).toEqual([expect.objectContaining({ role: "assistant", content: "partial answer" })]);
    expect(state.active).toBe(false);
  });

  it("turn_failed appends an inline error line and never opens a modal (invariant)", () => {
    const state = replay([
      event(1, "durable", { type: "turn_started", turn_id: "t1" }),
      event(2, "durable", { type: "turn_failed", turn_id: "t1", error: "boom", error_type: "ToolError" }),
    ]);
    expect(state.active).toBe(false);
    expect(state.entries.at(-1)).toMatchObject({ role: "system", tone: "error", content: "Turn failed: boom (ToolError)" });
  });
});

describe("conversation reducer — tool blocks", () => {
  it("tool_requested creates a block and tool_result merges by tool_call_id", () => {
    let state = replay([
      event(1, "durable", { type: "tool_requested", tool_call_id: "c1", tool_name: "bash", args_preview: "{}" }),
      event(2, "durable", { type: "tool_result", tool_call_id: "c1", status: "error", error: "exit 1", error_type: "BashError", duration_ms: 12 }),
    ]);
    expect(state.entries).toEqual([
      expect.objectContaining({ role: "tool", tool_call_id: "c1", name: "bash", status: "failed", result: "exit 1", duration_ms: 12, error_type: "BashError" }),
    ]);
  });

  it("file_change attaches to the existing tool block", () => {
    const state = replay([
      event(1, "durable", { type: "tool_requested", tool_call_id: "c1", name: "edit_file" }),
      event(2, "durable", { type: "file_change", tool_call_id: "c1", file_path: "src/app.py" }),
    ]);
    expect(state.entries[0]).toMatchObject({ role: "tool", name: "edit_file", file: "src/app.py" });
  });
});

describe("conversation reducer — question card state (§2.3)", () => {
  const questionEnvelope = event(1, "durable", {
    type: "user_question_requested",
    tool_call_id: "q1",
    question: "Proceed?",
    options: [{ value: "yes", label: "Yes" }],
  });

  it("question becomes pending, is answered once, and stays hidden afterwards", () => {
    let state = reduceConversation(emptyConversationState(), questionEnvelope);
    expect(state.question).toMatchObject({ toolCallId: "q1", status: "pending" });

    const key = questionKey(state.question);
    state = reduceConversation(state, { kind: "answered", key });
    expect(state.question).toBeNull();
    expect(state.resolvedQuestionKey).toBe(key);

    const after = reduceConversation(state, questionEnvelope);
    expect(after.question).toBeNull(); // answered cards stay answered
  });

  it("pending question is cancelled when the turn reaches a terminal state", () => {
    const state = replay([
      questionEnvelope,
      event(2, "durable", { type: "turn_cancelled", turn_id: "turn-1" }),
    ]);
    expect(state.question).toBeNull();
    expect(state.entries.at(-1)).toMatchObject({ role: "system", content: "Turn cancelled." });
  });
});

describe("conversation reducer — history and live_turn flows", () => {
  it("history load replaces entries via the messages array (initial load path)", () => {
    const state = reduceConversation(emptyConversationState(), {
      kind: "history",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "tool", tool_call_id: "h1", name: "grep", content: JSON.stringify({ ok: true }) },
      ],
    });
    expect(state.entries).toHaveLength(3);
    expect(state.entries[2]).toMatchObject({ role: "tool", tool_call_id: "h1", status: "completed" });
    expect(state.cursor).toBe(0);
    expect(state.seen).toEqual({});
  });

  it("live_turn snapshot merges tools, plan and activity", () => {
    let state = reduceConversation(emptyConversationState(), {
      kind: "history",
      messages: [{ role: "user", content: "do it" }],
    });
    state = reduceConversation(state, {
      kind: "live_turn",
      sessionId: "s1",
      liveTurn: {
        turn_id: "t9",
        status: "running",
        assistant_text: "working…",
        plan: [{ step: "a", status: "completed" }],
        tools: [{ tool_call_id: "c1", tool_name: "bash", status: "completed", output: "ok" }],
      },
    });
    expect(state.active).toBe(true);
    expect(state.activeTurnId).toBe("t9");
    expect(state.streaming).toEqual({ turnId: "t9", text: "working…" });
    expect(state.plan).toEqual([{ step: "a", status: "completed" }]);
    expect(state.entries[1]).toMatchObject({ role: "tool", tool_call_id: "c1", status: "completed", result: "ok" });
  });

  it("set_cursor adopts the server durable ordinal", () => {
    const state = reduceConversation(emptyConversationState(), { kind: "set_cursor", cursor: 42 });
    expect(state.cursor).toBe(42);
  });

  it("local messages and reset behave like the former appendMessage/clear flows", () => {
    let state = reduceConversation(emptyConversationState(), { kind: "message", role: "user", content: "go" });
    state = reduceConversation(state, { kind: "system", content: "Turn cancelled.", tone: "error" });
    expect(state.entries).toHaveLength(2);
    state = reduceConversation(state, { kind: "reset" });
    expect(state).toEqual(emptyConversationState());
  });
});

describe("conversation reducer — defenses", () => {
  it("ignores non-event messages (responses/requests from the fixture never enter)", () => {
    const state = emptyConversationState();
    expect(reduceConversation(state, { kind: "response", request_id: "x", result: {} })).toBe(state);
    expect(reduceConversation(state, { kind: "request", request_id: "y", method: "file/list" })).toBe(state);
    expect(reduceConversation(state, { kind: "event", event: null })).toBe(state);
  });

  it("envelopes without a sequence key are still applied exactly once each", () => {
    const envelope = { kind: "event", durability: "incremental", session_id: "s", turn_id: "t", event: { type: "assistant_delta", text: "a" } };
    const state = reduceConversation(emptyConversationState(), envelope);
    expect(state.streaming.text).toBe("a");
  });
});

function event(sequence, durability, extra = {}) {
  const turnId = String(extra.turn_id || "turn-1");
  return {
    kind: "event",
    method: "session/update",
    sequence,
    durability,
    session_id: "session-1",
    turn_id: turnId,
    event: { event_id: `event-${sequence}`, session_id: "session-1", turn_id: turnId, ...extra },
  };
}
