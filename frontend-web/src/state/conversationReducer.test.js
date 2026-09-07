import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationView, emptyConversationState, normalizeHistoryMessages, QUESTION_TTL_MS, questionKey, reduceConversation, TRANSCRIPT_CAP } from "./conversationReducer.js";

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
    ts: "2026-03-01T10:00:00Z",
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

describe("conversation reducer — question cards as stream entries (§2.3 answered stays visible)", () => {
  const questionEnvelope = event(1, "durable", {
    type: "user_question_requested",
    ts: "2026-03-01T10:00:00Z",
    tool_call_id: "q1",
    question: "Proceed?",
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  });

  it("a requested question is also inserted into the stream as a role=question entry", () => {
    const state = reduceConversation(emptyConversationState(), questionEnvelope);
    const entry = state.entries.find((item) => item.role === "question");
    expect(entry).toMatchObject({
      id: "question:session-1:q1",
      sessionId: "session-1",
      toolCallId: "q1",
      question: "Proceed?",
      status: "pending",
      selectedAnswer: "",
    });
    expect(entry.requestedAt).toBe(Date.parse("2026-03-01T10:00:00Z"));
    expect(entry.ttlMs).toBe(QUESTION_TTL_MS);
  });

  it("an explicit ttl_ms on the event overrides the default TTL", () => {
    const state = reduceConversation(emptyConversationState(), event(1, "durable", {
      type: "user_question_requested",
      tool_call_id: "q1",
      question: "Proceed?",
      ttl_ms: 5000,
    }));
    expect(state.question.ttlMs).toBe(5000);
  });

  it("answered freezes the entry in the stream with the chosen answer", () => {
    let state = reduceConversation(emptyConversationState(), questionEnvelope);
    const key = questionKey(state.question);
    state = reduceConversation(state, { kind: "answered", key, answer: "yes" });
    expect(state.question).toBeNull();
    const entry = state.entries.find((item) => item.role === "question");
    expect(entry).toMatchObject({ status: "answered", selectedAnswer: "yes" });

    // replay of the same request must not resurrect a pending card
    const after = reduceConversation(state, questionEnvelope);
    expect(after.entries.find((item) => item.role === "question").status).toBe("answered");
    expect(after.question).toBeNull();
  });

  it("question_expired marks the entry expired and clears the pointer", () => {
    let state = reduceConversation(emptyConversationState(), questionEnvelope);
    state = reduceConversation(state, { kind: "question_expired", key: "session-1:q1" });
    expect(state.question).toBeNull();
    expect(state.entries.find((item) => item.role === "question")).toMatchObject({ status: "expired" });
  });

  it("a turn terminal event cancels pending question entries instead of deleting them", () => {
    const state = replay([
      questionEnvelope,
      event(2, "durable", { type: "turn_completed", turn_id: "turn-1" }),
    ]);
    expect(state.question).toBeNull();
    expect(state.entries.find((item) => item.role === "question")).toMatchObject({ status: "cancelled" });
    expect(state.entries).toHaveLength(1); // kept, not removed
  });

  it("live_turn snapshots materialize the pending question entry too", () => {
    let state = reduceConversation(emptyConversationState(), { kind: "history", messages: [] });
    state = reduceConversation(state, {
      kind: "live_turn",
      sessionId: "session-1",
      liveTurn: { turn_id: "t9", status: "running", question: { tool_call_id: "q2", question: "Use db?", options: [] } },
    });
    expect(state.question).toMatchObject({ toolCallId: "q2", status: "pending" });
    expect(state.entries.at(-1)).toMatchObject({ role: "question", toolCallId: "q2", status: "pending" });
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

describe("conversation reducer — queued inputs (audit #1)", () => {
  const queueAction = { kind: "queue_input", inputId: "in-1", input: "follow up please", mode: "follow_up" };

  it("queue_input appends a user-styled queued entry and the queue array", () => {
    const state = reduceConversation(emptyConversationState(), queueAction);
    expect(state.queued).toEqual([{ inputId: "in-1", input: "follow up please", mode: "follow_up" }]);
    expect(state.entries.at(-1)).toMatchObject({ id: "queued:in-1", role: "queued", inputId: "in-1", mode: "follow_up" });
  });

  it("the queued_input_delivered event converts the chip into a normal user message", () => {
    let state = reduceConversation(emptyConversationState(), queueAction);
    state = reduceConversation(state, event(1, "durable", { type: "queued_input_delivered", input_id: "in-1", input: "follow up please", mode: "follow_up" }));
    expect(state.queued).toEqual([]);
    expect(state.entries.at(-1)).toMatchObject({ id: "msg:delivered:in-1", role: "user", content: "follow up please" });
    expect(state.entries.filter((entry) => entry.role === "queued")).toHaveLength(0);
  });

  it("delivery without an input_id falls back to the oldest queued item (kernel FIFO)", () => {
    let state = reduceConversation(emptyConversationState(), { kind: "queue_input", inputId: "in-1", input: "first", mode: "follow_up" });
    state = reduceConversation(state, { kind: "queue_input", inputId: "in-2", input: "second", mode: "steering" });
    state = reduceConversation(state, event(1, "durable", { type: "queued_input_delivered", input: "first", mode: "follow_up" }));
    expect(state.queued.map((item) => item.inputId)).toEqual(["in-2"]);
    // the oldest chip converted in place into a normal user message
    expect(state.entries.find((entry) => entry.id === "msg:delivered:in-1")).toMatchObject({ role: "user", content: "first" });
    expect(state.entries.filter((entry) => entry.role === "queued")).toHaveLength(1);
  });

  it("delivery of an unknown input still renders the message (transcript stays faithful)", () => {
    const state = reduceConversation(emptyConversationState(), event(1, "durable", { type: "queued_input_delivered", input_id: "ghost", input: "hi", mode: "steering" }));
    expect(state.entries.at(-1)).toMatchObject({ role: "user", content: "hi" });
  });

  it("unqueue removes the chip (取回) and requeue flips the mode in place (转向)", () => {
    let state = reduceConversation(emptyConversationState(), queueAction);
    state = reduceConversation(state, { kind: "unqueue", inputId: "in-1" });
    expect(state.queued).toEqual([]);
    expect(state.entries.some((entry) => entry.role === "queued")).toBe(false);

    state = reduceConversation(emptyConversationState(), queueAction);
    state = reduceConversation(state, { kind: "requeue", inputId: "in-1", mode: "steering" });
    expect(state.queued[0]).toMatchObject({ inputId: "in-1", mode: "steering" });
    expect(state.entries.at(-1)).toMatchObject({ role: "queued", mode: "steering" });
    expect(state.entries).toHaveLength(1); // in place, not moved
  });

  it("turn_cancelled clears the queue (kernel discards pending inputs); turn_completed keeps it", () => {
    let state = reduceConversation(emptyConversationState(), queueAction);
    state = reduceConversation(state, event(1, "durable", { type: "turn_cancelled", turn_id: "turn-1" }));
    expect(state.queued).toEqual([]);

    state = reduceConversation(emptyConversationState(), queueAction);
    state = reduceConversation(state, event(1, "durable", { type: "turn_completed", turn_id: "turn-1" }));
    expect(state.queued).toHaveLength(1); // follow_up rolls into the next turn
  });

  it("live_turn restores pending_inputs as chips so a reconnect re-renders the queue", () => {
    let state = reduceConversation(emptyConversationState(), { kind: "history", messages: [] });
    state = reduceConversation(state, {
      kind: "live_turn",
      sessionId: "s1",
      liveTurn: {
        turn_id: "t9",
        status: "running",
        pending_inputs: [
          { input_id: "in-a", input: "queued steer", mode: "steering" },
          { input_id: "in-b", input: "queued follow", mode: "follow_up" },
        ],
      },
    });
    expect(state.queued.map((item) => item.inputId)).toEqual(["in-a", "in-b"]);
    expect(state.entries.filter((entry) => entry.role === "queued")).toHaveLength(2);
    expect(state.entries.at(-1)).toMatchObject({ role: "queued", inputId: "in-b", mode: "follow_up" });
  });

  it("live_turn drops chips the snapshot no longer lists and updates existing ones in place", () => {
    let state = reduceConversation(emptyConversationState(), { kind: "queue_input", inputId: "in-a", input: "kept", mode: "follow_up" });
    state = reduceConversation(state, { kind: "queue_input", inputId: "in-gone", input: "gone", mode: "follow_up" });
    state = reduceConversation(state, {
      kind: "live_turn",
      sessionId: "s1",
      liveTurn: { turn_id: "t9", status: "running", pending_inputs: [{ input_id: "in-a", input: "kept", mode: "steering" }] },
    });
    expect(state.queued).toEqual([{ inputId: "in-a", input: "kept", mode: "steering" }]);
    expect(state.entries.filter((entry) => entry.role === "queued")).toHaveLength(1); // no duplicate chip
  });

  it("conversationView exposes queued/collapsedCount/turnChanges", () => {
    let state = reduceConversation(emptyConversationState(), queueAction);
    const view = conversationView(state);
    expect(view.queued).toHaveLength(1);
    expect(view.collapsedCount).toBe(0);
    expect(view.turnChanges).toBeNull();
  });
});

describe("conversation reducer — transcript cap (audit #5)", () => {
  it("drops the OLDEST entries beyond the cap and counts them in collapsedCount", () => {
    let state = emptyConversationState();
    for (let index = 0; index < TRANSCRIPT_CAP + 7; index += 1) {
      state = reduceConversation(state, { kind: "message", role: "user", content: `m${index}` });
    }
    expect(state.entries).toHaveLength(TRANSCRIPT_CAP);
    expect(state.collapsedCount).toBe(7);
    expect(state.entries[0].content).toBe("m7"); // oldest dropped
    expect(state.entries.at(-1).content).toBe(`m${TRANSCRIPT_CAP + 6}`);
  });
});

describe("conversation reducer — turn-scoped change summary (audit #14)", () => {
  const editResult = JSON.stringify({ ok: true, meta: { files: [{ path: "src/app.py", added_lines: 3, removed_lines: 1 }] } });

  it("a finished turn with file mutations records 改动 stats and the first diff tool id", () => {
    const state = replay([
      event(1, "durable", { type: "turn_started", turn_id: "t1" }),
      event(2, "durable", { type: "tool_requested", turn_id: "t1", tool_call_id: "c1", tool_name: "edit_file", args_preview: "{}" }),
      event(3, "durable", { type: "tool_result", turn_id: "t1", tool_call_id: "c1", status: "completed", result: editResult }),
      event(4, "durable", { type: "turn_completed", turn_id: "t1" }),
    ]);
    expect(state.turnChanges).toEqual({ fileCount: 1, added: 3, removed: 1, firstToolCallId: "c1" });
  });

  it("a turn without mutations records no summary", () => {
    const state = replay([
      event(1, "durable", { type: "turn_started", turn_id: "t1" }),
      event(2, "durable", { type: "tool_requested", turn_id: "t1", tool_call_id: "c1", tool_name: "bash", args_preview: "{}" }),
      event(3, "durable", { type: "tool_result", turn_id: "t1", tool_call_id: "c1", status: "completed", result: "ok" }),
      event(4, "durable", { type: "turn_completed", turn_id: "t1" }),
    ]);
    expect(state.turnChanges).toBeNull();
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
