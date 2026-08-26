export const runtimeProtocolVersion = "2";

export const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export const runtimeMethods = Object.freeze({
  initialize: "initialize",
  shutdown: "shutdown",
  sessionNew: "session/new",
  sessionList: "session/list",
  sessionSwitch: "session/switch",
  sessionReplay: "session/replay",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  modelList: "model/list",
  modelSet: "model/set",
  modelEffortSet: "model/effort",
  sessionSteer: "rind/session/steer",
  sessionFollowUp: "rind/session/follow_up",
  sessionPromoteFollowUp: "rind/session/promote_follow_up",
  sessionUnsteer: "rind/session/unsteer",
  sessionDequeueFollowUp: "rind/session/dequeue_follow_up",
  sessionCompact: "rind/session/compact",
  commandExecute: "rind/command/execute",
  userQuestionRespond: "rind/user-question/respond",
  backgroundList: "rind/background/list",
  backgroundOutput: "rind/background/output",
  goalGet: "rind/goal/get",
  goalSet: "rind/goal/set",
  goalStatus: "rind/goal/status",
  goalClear: "rind/goal/clear",
});

export const sessionScopedMethods = new Set([
  runtimeMethods.sessionPrompt,
  runtimeMethods.sessionReplay,
  runtimeMethods.sessionSwitch,
  runtimeMethods.sessionCancel,
  runtimeMethods.modelSet,
  runtimeMethods.modelEffortSet,
  runtimeMethods.sessionSteer,
  runtimeMethods.sessionFollowUp,
  runtimeMethods.sessionPromoteFollowUp,
  runtimeMethods.sessionUnsteer,
  runtimeMethods.sessionDequeueFollowUp,
  runtimeMethods.sessionCompact,
  runtimeMethods.commandExecute,
  runtimeMethods.userQuestionRespond,
  runtimeMethods.backgroundList,
  runtimeMethods.backgroundOutput,
  runtimeMethods.goalGet,
  runtimeMethods.goalSet,
  runtimeMethods.goalStatus,
  runtimeMethods.goalClear,
]);

export const turnScopedMethods = new Set([
  runtimeMethods.sessionCancel,
  runtimeMethods.sessionSteer,
]);

export function createRuntimeRequest(requestId, method, params = {}) {
  return { kind: "request", request_id: requestId, method, params };
}

export function isRuntimeResponse(message) {
  return message?.kind === "response"
    && isRequestId(message.request_id)
    && (Object.hasOwn(message, "result") || isRuntimeError(message.error));
}

export function isRuntimeEvent(message) {
  return message?.kind === "event"
    && message.method === "session/update"
    && Number.isInteger(message.sequence)
    && (message.durability === "durable" || message.durability === "incremental")
    && typeof message.session_id === "string"
    && typeof message.turn_id === "string"
    && isRecord(message.event);
}

export function requireRuntimeInitialization(result) {
  if (!isRecord(result) || result.protocol_version !== runtimeProtocolVersion) {
    const received = isRecord(result) ? String(result.protocol_version || "missing") : "invalid";
    throw new Error(`Unsupported Runtime protocol version: ${received}.`);
  }
  if (!Array.isArray(result.capabilities) || !Array.isArray(result.methods)) {
    throw new Error("Runtime initialization response is missing capabilities or methods.");
  }
  return result;
}

export function runtimeRequestId(message) {
  return message?.request_id;
}

export function runtimeEventType(message) {
  return message?.event?.type || "";
}

export function isRuntimeEventForTurn(message, sessionId = "", turnId = "") {
  const eventSessionId = String(message?.session_id || "");
  if (sessionId && eventSessionId && eventSessionId !== sessionId) {
    return false;
  }
  if (runtimeEventType(message) === "turn_started") {
    return Boolean(String(message?.turn_id || ""));
  }
  const eventTurnId = String(message?.turn_id || "");
  return !eventTurnId || Boolean(turnId && eventTurnId === turnId);
}

function isRequestId(value) {
  return (typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value));
}

function isRuntimeError(value) {
  return isRecord(value) && typeof value.type === "string" && typeof value.message === "string";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
