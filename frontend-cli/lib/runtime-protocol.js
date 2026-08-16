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

export function runtimeRequestId(message) {
  return message?.request_id;
}

export function runtimeEventType(message) {
  return message?.event?.type || "";
}

export function turnInputMethod(activeTurn) {
  return activeTurn ? runtimeMethods.sessionFollowUp : runtimeMethods.sessionPrompt;
}
