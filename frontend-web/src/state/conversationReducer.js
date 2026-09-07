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
// Non-event actions keep the existing flows working:
//   { kind: "history", messages }        initial session/replay messages load
//   { kind: "live_turn", liveTurn, sessionId }  live_turn snapshot reconciliation
//   { kind: "message", role, content, tone }    optimistic local messages
//   { kind: "system", content, tone }           (alias of message with role "system")
//   { kind: "answered", key }            question card answered
//   { kind: "set_cursor", cursor }       adopt the server's durable ordinal
//   { kind: "reset" }                    clear session

export function emptyConversationState() {
  return {
    entries: [], // ordered messages: {id, role: "user"|"assistant"|"system", content, tone?} | tool blocks
    streaming: null, // { turnId, text } — in-flight assistant text for the active turn
    active: false,
    activeTurnId: "",
    plan: [],
    question: null, // { sessionId, toolCallId, question, options, status: "pending"|"answered" }
    resolvedQuestionKey: "",
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
    case "answered": {
      const key = String(action.key || "");
      if (!key) return state;
      return { ...state, question: null, resolvedQuestionKey: key };
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
    question: state.question,
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
  next = applyTurnEvent(next, event, { sessionId, turnId, key });
  if (String(envelope.durability) === "durable") next = { ...next, cursor: next.cursor + 1 };
  return next;
}

function applyTurnEvent(state, event, context) {
  const turnId = context.turnId;
  switch (event.type) {
    case "turn_started":
      return { ...state, active: true, activeTurnId: turnId, streaming: { turnId, text: "" } };

    case "assistant_delta": {
      const streaming = state.streaming && state.streaming.turnId === turnId
        ? state.streaming
        : { turnId, text: "" };
      return {
        ...state,
        active: true,
        streaming: { turnId, text: streaming.text + String(event.text || "") },
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
      };
      const name = String(event.tool_name || event.name || "");
      if (name) patch.name = name;
      return upsertTool(state, definedOnly(patch));
    }

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
      return { ...state, question: { ...question, status: existing?.status || "pending" } };
    }

    case "queued_input_delivered":
      return appendEntry(state, { role: "system", content: `Steering input delivered: ${event.input || ""}` });

    case "goal_continued":
      return appendEntry(state, { role: "system", content: `Goal continuation · round ${event.round || "?"}` });

    case "turn_failed": {
      const finalized = finalizeTurn(state, turnId);
      return appendEntry(finalized, { role: "system", content: formatTurnFailure(event), tone: "error" });
    }

    case "turn_cancelled": {
      const finalized = finalizeTurn(state, turnId);
      return appendEntry(finalized, { role: "system", content: "Turn cancelled." });
    }

    case "turn_completed":
      return finalizeTurn(state, turnId);

    default:
      return state;
  }
}

function finalizeTurn(state, turnId) {
  const streamingText = state.streaming ? state.streaming.text : "";
  let next = streamingText
    ? appendEntry(state, { id: `msg:${state.activeTurnId || turnId}:final`, role: "assistant", content: streamingText })
    : state;
  return {
    ...next,
    active: false,
    activeTurnId: "",
    streaming: null,
    question: null, // pending question dies with its turn (§2.3 cancelled)
  };
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
    return { ...state, active: false, activeTurnId: "", streaming: null, question: null };
  }
  let next = {
    ...state,
    active: liveTurn.status === "running",
    activeTurnId: String(liveTurn.turn_id || ""),
    streaming: { turnId: String(liveTurn.turn_id || ""), text: String(liveTurn.assistant_text || "") },
  };
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
  next = { ...next, question: question && !keepAnswered ? { ...question, status: "pending" } : null };
  return next;
}

function appendEntry(state, entry) {
  const id = entry.id || `local-${state.entries.length}`;
  return { ...state, entries: [...state.entries, { id, ...entry }] };
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
  return {
    sessionId: String(value.sessionId || value.session_id || fallbackSessionId || "").trim(),
    toolCallId,
    question: String(value.question || ""),
    options: Array.isArray(value.options) ? value.options : [],
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
