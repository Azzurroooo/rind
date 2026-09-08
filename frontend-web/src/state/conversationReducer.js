// Conversation event reduction (web-ui.md §3) — pure `(state, envelope) => state`.
//
// The UI stream is a pure function of the event envelope stream, so a reconnect
// catch-up replay can rebuild it bit-for-bit. Rules:
//   - event key = (session_id, turn_id, sequence); duplicate keys are dropped
//     idempotently (guard against replay/live overlap after reconnect);
//   - `assistant` deltas aggregate per turn into one streaming message;
//   - `tool_requested` creates a tool block, `tool_result` merges by tool_call_id;
//   - turn terminal events finalize the turn and flush streaming text;
//   - every envelope with durability === "durable" advances the local cursor
//     (which is what `session/replay { after_cursor }` resumes from).
//
// Queued inputs (steer / follow_up) live in the stream as `role: "queued"`
// entries with a matching `state.queued` array, so a reconnect's live_turn
// snapshot (pending_inputs) re-renders the queue bit-for-bit. The
// `queued_input_delivered` event converts the chip into a normal user message.
//
// Transcript governance (§ audit #5): `appendEntry` caps the stream at
// TRANSCRIPT_CAP entries, dropping the OLDEST and counting them in
// `collapsedCount` so long-running sessions cannot grow without bound.
//
// Non-event actions keep the existing flows working:
//   { kind: "history", messages }        initial session/replay messages load
//   { kind: "live_turn", liveTurn, sessionId }  live_turn snapshot reconciliation
//   { kind: "message", role, content, tone }    optimistic local messages
//   { kind: "system", content, tone }           (alias of message with role "system")
//   { kind: "answered", key, answer }    question card answered (stays in stream)
//   { kind: "question_expired", key }    question card TTL reached (§2.3 expired)
//   { kind: "queue_input", inputId, input, mode }  input accepted into the queue
//   { kind: "unqueue", inputId }         queued input retrieved (取回)
//   { kind: "queued_delivered", inputId, input?, mode? }  chip → user message
//   { kind: "set_cursor", cursor }       adopt the server's durable ordinal
//   { kind: "reset" }                    clear session
//
// Question cards (web-ui.md §2.3) live twice in state: the `question` pointer
// tracks the one card that can still be answered, while every card is ALSO a
// stream entry (role "question") so the answered/cancelled card remains
// readable in the transcript instead of vanishing.
import { summarizeChanges } from "../lib/toolDisplay.js";

// Stream length ceiling (audit #5): dropping the oldest keeps month-long
// sessions bounded; the collapsed divider keeps the truncation honest.
export const TRANSCRIPT_CAP = 400;

// Client-side TTL for the silent countdown; the wire event may override it
// with ttl_ms once the worker reports one.
export const QUESTION_TTL_MS = 120_000;

export function emptyConversationState() {
  return {
    entries: [], // ordered messages: {id, role: "user"|"assistant"|"system", content, tone?} | tool blocks
    streaming: null, // { turnId, text } — in-flight assistant text for the active turn
    active: false,
    activeTurnId: "",
    plan: [],
    question: null, // { sessionId, toolCallId, question, options, status, requestedAt, ttlMs }
    resolvedQuestionKey: "",
    queued: [], // [{inputId, input, mode}] — inputs accepted but not yet delivered
    collapsedCount: 0, // entries dropped by the TRANSCRIPT_CAP (oldest first)
    turnChanges: null, // { fileCount, added, removed, firstToolCallId } — last finished turn's mutations
    activeSince: 0, // epoch ms of turn_started (event `ts`); 0 when unknown
    stepRetry: null, // { attempt, reason } — latest turn_step_retry; cleared once text flows again
    cursor: 0, // durable events applied for the current session
    seen: {}, // "session:turn:sequence" -> true (idempotence guard)
  };
}

export function reduceConversation(state, action) {
  if (!action || typeof action !== "object") return state;
  if (action.kind === "event") return applyEnvelope(state, action);
  switch (action.kind) {
    case "history":
      return applyHistory(state, action.messages);
    case "live_turn":
      return applyLiveTurn(state, action.liveTurn, action.sessionId);
    case "message":
    case "system":
      return appendEntry(state, {
        role: action.role || (action.kind === "system" ? "system" : "user"),
        content: String(action.content || ""),
        tone: action.tone || "",
      });
    case "queue_input": {
      const inputId = String(action.inputId || "").trim();
      const input = String(action.input || "");
      if (!inputId || !input) return state;
      const mode = action.mode === "steering" ? "steering" : "follow_up";
      const entry = { id: `queued:${inputId}`, role: "queued", inputId, input, mode };
      return withCap({
        ...state,
        queued: [...state.queued, { inputId, input, mode }],
        entries: [...state.entries, entry],
      });
    }
    case "unqueue": {
      const inputId = String(action.inputId || "").trim();
      if (!inputId) return state;
      if (!state.queued.some((item) => item.inputId === inputId)) return state;
      return {
        ...state,
        queued: state.queued.filter((item) => item.inputId !== inputId),
        entries: state.entries.filter((entry) => !(entry.role === "queued" && entry.inputId === inputId)),
      };
    }
    case "requeue": {
      // promote_follow_up moved the item into the steering queue kernel-side;
      // flip the chip's mode in place instead of moving the row.
      const inputId = String(action.inputId || "").trim();
      if (!inputId || action.mode !== "steering") return state;
      if (!state.queued.some((item) => item.inputId === inputId && item.mode !== "steering")) return state;
      return {
        ...state,
        queued: state.queued.map((item) => (item.inputId === inputId ? { ...item, mode: "steering" } : item)),
        entries: state.entries.map((entry) => (entry.role === "queued" && entry.inputId === inputId ? { ...entry, mode: "steering" } : entry)),
      };
    }
    case "queued_delivered":
      return deliverQueued(state, action.inputId, action.input, action.mode);
    case "answered": {
      const key = String(action.key || "");
      if (!key) return state;
      // Answered cards freeze in the stream (§2.3) — only the pointer clears.
      const next = markQuestionEntry(state, key, { status: "answered", selectedAnswer: String(action.answer || "") });
      const pointerMatches = next.question && questionKey(next.question) === key;
      return { ...next, question: pointerMatches ? null : next.question, resolvedQuestionKey: key };
    }
    case "question_expired": {
      const key = String(action.key || "");
      if (!key) return state;
      const next = markQuestionEntry(state, key, { status: "expired" });
      const pointerMatches = next.question && questionKey(next.question) === key;
      return { ...next, question: pointerMatches ? null : next.question };
    }
    case "set_cursor":
      return { ...state, cursor: Math.max(0, Number(action.cursor) || 0) };
    case "reset":
      return emptyConversationState();
    default:
      return state;
  }
}

export function conversationView(state) {
  return {
    messages: state.entries,
    draft: state.streaming ? state.streaming.text : "",
    plan: state.plan,
    active: state.active,
    activeSince: state.activeSince,
    stepRetry: state.stepRetry,
    question: state.question,
    queued: state.queued,
    collapsedCount: state.collapsedCount,
    turnChanges: state.turnChanges,
    cursor: state.cursor,
  };
}

function applyEnvelope(state, envelope) {
  const event = envelope?.event;
  if (!event || typeof event !== "object") return state;
  const sessionId = String(envelope.session_id || event.session_id || "");
  const turnId = String(envelope.turn_id || event.turn_id || "");
  const hasKey = envelope.sequence != null || event.event_id != null;
  const key = `${sessionId}:${turnId}:${envelope.sequence ?? event.event_id ?? ""}`;
  if (hasKey && state.seen[key]) return state; // duplicate → idempotent drop
  let next = hasKey ? { ...state, seen: { ...state.seen, [key]: true } } : state;
  // Delta coalescing (lib/streamController.js): merged envelopes carry the
  // sequence numbers of the deltas they absorbed so a replayed stream can
  // never re-apply them.
  const absorbed = Array.isArray(envelope.absorbed) ? envelope.absorbed : [];
  if (absorbed.length) {
    const seen = { ...next.seen };
    for (const value of absorbed) {
      if (value != null) seen[`${sessionId}:${turnId}:${value}`] = true;
    }
    next = { ...next, seen };
  }
  next = applyTurnEvent(next, event, { sessionId, turnId, key });
  if (String(envelope.durability) === "durable") next = { ...next, cursor: next.cursor + 1 };
  return next;
}

function applyTurnEvent(state, event, context) {
  const turnId = context.turnId;
  switch (event.type) {
    case "turn_started":
      return { ...state, active: true, activeTurnId: turnId, activeSince: epochMs(event.ts), streaming: { turnId, text: "" }, stepRetry: null };

    case "assistant_delta": {
      const streaming = state.streaming && state.streaming.turnId === turnId
        ? state.streaming
        : { turnId, text: "" };
      return {
        ...state,
        active: true,
        streaming: { turnId, text: streaming.text + String(event.text || "") },
        stepRetry: null, // the model is producing again — the retry note served its purpose
      };
    }

    case "assistant_message_completed": {
      const fromStream = state.streaming && state.streaming.turnId === turnId ? state.streaming.text : "";
      const content = String(event.content || fromStream || "");
      let next = content ? appendEntry(state, { id: `msg:${context.key}`, role: "assistant", content }) : state;
      if (next.streaming && next.streaming.turnId === turnId) next = { ...next, streaming: null };
      return next;
    }

    case "tool_requested":
    case "tool_call_started":
      return upsertTool(state, {
        id: String(event.tool_call_id || ""),
        name: String(event.tool_name || event.name || "tool"),
        args: String(event.args_preview || ""),
        status: "running",
      });

    case "tool_result": {
      const status = event.status === "error" || event.ok === false
        ? "failed"
        : String(event.status || "completed");
      const patch = {
        id: String(event.tool_call_id || ""),
        result: String(firstDefined(event.result, event.output, event.error, event.error_source) ?? ""),
        status,
        duration_ms: event.duration_ms,
        error_type: event.error_type,
        progress: "", // the heartbeat chip dies with the result
      };
      const name = String(event.tool_name || event.name || "");
      if (name) patch.name = name;
      return upsertTool(state, definedOnly(patch));
    }

    case "tool_progress":
      // Heartbeat for long-running tools (e.g. bash): `still running (42s)`.
      // Latest wins — it is a state, not a stream.
      return upsertTool(state, {
        id: String(event.tool_call_id || ""),
        progress: progressText(event.payload),
      });

    case "turn_step_retry":
      return { ...state, stepRetry: { attempt: Number(event.attempt) || 0, reason: String(event.reason || "") } };

    case "file_change":
      return upsertTool(state, { id: String(event.tool_call_id || ""), file: event.file_path });

    case "plan_updated":
      return { ...state, plan: Array.isArray(event.plan) ? event.plan : [] };

    case "user_question_requested": {
      const question = normalizeQuestion(event, context.sessionId);
      if (!question) return state;
      const key = questionKey(question);
      if (key === state.resolvedQuestionKey) return state;
      const existing = state.question && questionKey(state.question) === key ? state.question : null;
      const nextQuestion = { ...question, status: existing?.status || "pending" };
      return withQuestionEntry({ ...state, question: nextQuestion }, nextQuestion);
    }

    case "queued_input_delivered":
      // The queued chip converts into a normal user message in place.
      return deliverQueued(state, event.input_id, event.input, event.mode);

    case "goal_continued":
      return appendEntry(state, { role: "system", content: `Goal continuation · round ${event.round || "?"}` });

    case "turn_failed": {
      // The kernel discards pending queued inputs on failure — mirror that.
      const cleared = { ...state, queued: [] };
      const finalized = finalizeTurn(cleared, turnId);
      return appendEntry(finalized, { role: "system", content: formatTurnFailure(event), tone: "error" });
    }

    case "turn_cancelled": {
      const cleared = { ...state, queued: [] };
      const finalized = finalizeTurn(cleared, turnId);
      return appendEntry(finalized, { role: "system", content: "Turn cancelled." });
    }

    case "turn_completed":
      // follow_up inputs roll into the NEXT turn (kernel keeps them queued),
      // so the queue survives a completed turn until delivery.
      return finalizeTurn(state, turnId);

    default:
      return state;
  }
}

function finalizeTurn(state, turnId) {
  const streamingText = state.streaming ? state.streaming.text : "";
  const next = streamingText
    ? appendEntry(state, { id: `msg:${state.activeTurnId || turnId}:final`, role: "assistant", content: streamingText })
    : state;
  const entries = next.entries.some((entry) => entry.role === "question" && entry.status === "pending")
    ? next.entries.map((entry) => (entry.role === "question" && entry.status === "pending" ? { ...entry, status: "cancelled" } : entry))
    : next.entries;
  return {
    ...next,
    entries,
    active: false,
    activeTurnId: "",
    activeSince: 0,
    streaming: null,
    stepRetry: null,
    question: null, // pending question dies with its turn (§2.3 cancelled)
    turnChanges: summarizeChanges(entries),
  };
}

// Queued chip → normal user message. With an input_id the exact chip is
// converted; without one (legacy event) the oldest matching mode is delivered
// first, mirroring the kernel's FIFO consumption.
function deliverQueued(state, inputId, input, mode) {
  const cleanId = String(inputId || "").trim();
  let item = null;
  if (cleanId) {
    item = state.queued.find((candidate) => candidate.inputId === cleanId) || null;
  }
  if (!item) {
    const wantedMode = mode === "steering" ? "steering" : mode === "follow_up" ? "follow_up" : "";
    item = state.queued.find((candidate) => (!wantedMode || candidate.mode === wantedMode)) || null;
  }
  if (!item) {
    // Nothing queued locally (e.g. delivery predates the snapshot): still show
    // the message so the transcript stays faithful.
    return appendEntry(state, { role: "user", content: String(input || ""), tone: "" });
  }
  const delivered = {
    id: `msg:delivered:${item.inputId}`,
    role: "user",
    content: String(input || item.input),
    tone: "",
  };
  const index = state.entries.findIndex((entry) => entry.role === "queued" && entry.inputId === item.inputId);
  const entries = [...state.entries];
  if (index < 0) entries.push(delivered);
  else entries[index] = delivered;
  return withCap({
    ...state,
    queued: state.queued.filter((candidate) => candidate.inputId !== item.inputId),
    entries,
  });
}

// Question cards live in the stream so answered/cancelled history stays readable.
function withQuestionEntry(state, question) {
  const key = questionKey(question);
  const index = state.entries.findIndex((entry) => entry.role === "question" && questionKey(entry) === key);
  const fields = {
    role: "question",
    sessionId: question.sessionId,
    toolCallId: question.toolCallId,
    question: question.question,
    options: question.options,
    requestedAt: question.requestedAt,
    ttlMs: question.ttlMs,
  };
  if (index < 0) {
    return { ...state, entries: [...state.entries, { id: `question:${key}`, status: question.status || "pending", selectedAnswer: "", ...fields }] };
  }
  const entries = [...state.entries];
  entries[index] = { ...entries[index], ...fields }; // keeps local status/selectedAnswer
  return { ...state, entries };
}

function markQuestionEntry(state, key, patch) {
  const index = state.entries.findIndex((entry) => entry.role === "question" && questionKey(entry) === key);
  if (index < 0) return state;
  const entries = [...state.entries];
  entries[index] = { ...entries[index], ...definedOnly(patch) };
  return { ...state, entries };
}

function upsertTool(state, patch) {
  if (!patch.id) return state;
  const index = state.entries.findIndex((entry) => entry.role === "tool" && entry.tool_call_id === patch.id);
  if (index < 0) {
    return {
      ...state,
      entries: [...state.entries, { id: `tool-${patch.id}`, role: "tool", tool_call_id: patch.id, name: "tool", ...definedOnly(patch) }],
    };
  }
  const entries = [...state.entries];
  entries[index] = { ...entries[index], ...definedOnly(patch) };
  return { ...state, entries };
}

// Drops undefined/null fields so merges never clobber existing values.
function definedOnly(patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) clean[key] = value;
  }
  return clean;
}

// Initial history load via session/replay `messages` (existing flow, unchanged).
function applyHistory(state, messages) {
  const fresh = emptyConversationState();
  return { ...fresh, entries: normalizeHistoryMessages(messages) };
}

// live_turn snapshot reconciliation (used right after a history load).
function applyLiveTurn(state, liveTurn, sessionId) {
  if (!liveTurn || typeof liveTurn !== "object") {
    return { ...state, active: false, activeTurnId: "", activeSince: 0, streaming: null, stepRetry: null, question: null, queued: [] };
  }
  let next = {
    ...state,
    active: liveTurn.status === "running",
    activeTurnId: String(liveTurn.turn_id || ""),
    activeSince: 0, // the snapshot carries no start time; elapsed restarts after a reload
    stepRetry: null,
    streaming: { turnId: String(liveTurn.turn_id || ""), text: String(liveTurn.assistant_text || "") },
    // The snapshot is authoritative for the queue: rebuild it from
    // pending_inputs so a reconnect re-renders exactly what the kernel holds.
    queued: [],
  };
  const staleQueuedIds = new Set(state.queued.map((item) => item.inputId));
  for (const pending of Array.isArray(liveTurn.pending_inputs) ? liveTurn.pending_inputs : []) {
    const inputId = String(pending?.input_id || "").trim();
    const input = String(pending?.input || "");
    if (!inputId || !input) continue;
    if (!state.queued.some((item) => item.inputId === inputId)) {
      const mode = pending.mode === "steering" ? "steering" : "follow_up";
      next = withCap({
        ...next,
        queued: [...next.queued, { inputId, input, mode }],
        entries: [...next.entries, { id: `queued:${inputId}`, role: "queued", inputId, input, mode }],
      });
    } else {
      next = { ...next, queued: [...next.queued, { inputId, input, mode: pending.mode === "steering" ? "steering" : "follow_up" }] };
    }
  }
  // Chips the snapshot no longer lists are gone kernel-side: drop them.
  const keepIds = new Set(next.queued.map((item) => item.inputId));
  if (staleQueuedIds.size) {
    next = { ...next, entries: next.entries.filter((entry) => entry.role !== "queued" || keepIds.has(entry.inputId)) };
  }
  if (Array.isArray(liveTurn.plan)) next = { ...next, plan: liveTurn.plan };
  for (const tool of Array.isArray(liveTurn.tools) ? liveTurn.tools : []) {
    next = upsertTool(next, {
      id: String(tool.tool_call_id || ""),
      name: String(tool.tool_name || "tool"),
      args: String(tool.args_preview || ""),
      result: String(tool.output || ""),
      status: tool.status === "error" ? "failed" : tool.status === "completed" ? "completed" : "running",
    });
  }
  const question = normalizeQuestion(liveTurn.question, sessionId);
  const keepAnswered = question && questionKey(question) === state.resolvedQuestionKey;
  const activeQuestion = question && !keepAnswered ? { ...question, status: "pending" } : null;
  next = activeQuestion ? withQuestionEntry({ ...next, question: activeQuestion }, activeQuestion) : { ...next, question: null };
  return next;
}

function appendEntry(state, entry) {
  const id = entry.id || `local-${state.entries.length}`;
  return withCap({ ...state, entries: [...state.entries, { id, ...entry }] });
}

// Drops the OLDEST entries beyond the cap; the count surfaces as the
// "更早的消息已折叠" divider so truncation is never silent.
function withCap(state) {
  const overflow = state.entries.length - TRANSCRIPT_CAP;
  if (overflow <= 0) return state;
  return {
    ...state,
    entries: state.entries.slice(overflow),
    collapsedCount: state.collapsedCount + overflow,
  };
}

// ---- shared normalization helpers (ported from the former App.jsx handlers) ----

export function normalizeHistoryMessages(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((message) => ["user", "assistant", "tool"].includes(message?.role))
    .map((message, index) => {
      if (message.role === "tool") {
        const content = contentText(message.content);
        const payload = parseToolPayload(content);
        return {
          id: message.id || `history-tool-${message.tool_call_id || index}`,
          role: "tool",
          tool_call_id: message.tool_call_id || `history-${index}`,
          name: message.name || message.tool_name || payload?.tool || "tool",
          result: content,
          status: payload?.ok === false ? "failed" : "completed",
        };
      }
      return {
        id: message.id || `history-${index}`,
        role: message.role,
        content: contentText(message.content),
        meta: "",
      };
    })
    .filter((message) => message.role === "tool" || message.content);
}

export function normalizeQuestion(value, fallbackSessionId = "") {
  if (!value || typeof value !== "object") return null;
  const toolCallId = String(value.toolCallId || value.tool_call_id || "").trim();
  if (!toolCallId) return null;
  const requestedAt = Date.parse(value.requestedAt || value.ts || "") || 0;
  const explicitTtl = Number(value.ttl_ms || value.ttlMs);
  return {
    sessionId: String(value.sessionId || value.session_id || fallbackSessionId || "").trim(),
    toolCallId,
    question: String(value.question || ""),
    options: Array.isArray(value.options) ? value.options : [],
    requestedAt: Number.isFinite(requestedAt) ? requestedAt : 0,
    ttlMs: Number.isFinite(explicitTtl) && explicitTtl > 0 ? explicitTtl : QUESTION_TTL_MS,
  };
}

export function questionKey(question) {
  return `${question.sessionId}:${question.toolCallId}`;
}

function formatTurnFailure(event) {
  const message = String(event?.error || "Runtime error");
  const details = [event?.error_type, event?.error_source].filter(Boolean).join(" · ");
  return details ? `Turn failed: ${message} (${details})` : `Turn failed: ${message}`;
}

function parseToolPayload(content) {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : item?.text || "")).join("");
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

// Runtime events stamp `ts` either as epoch seconds (domain default) or as an
// ISO instant (the worker path re-stamps with session.now_iso()).
function epochMs(ts) {
  const raw = String(ts || "").trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.trunc(seconds * 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// tool_progress payloads arrive as plain strings or objects ({message}).
function progressText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") return String(payload.message || "");
  return String(payload);
}
