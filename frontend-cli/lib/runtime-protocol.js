export const runtimeProtocolVersion = "2";

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
  sessionSteer: "rind/session/steer",
  sessionFollowUp: "rind/session/follow_up",
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

function isRequestId(value) {
  return (typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value));
}

function isRuntimeError(value) {
  return isRecord(value) && typeof value.type === "string" && typeof value.message === "string";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
