export const methods = Object.freeze({
  initialize: "initialize",
  sessionList: "session/list",
  sessionNew: "session/new",
  sessionSwitch: "session/switch",
  sessionReplay: "session/replay",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionDelete: "session/delete",
  sessionSteer: "rind/session/steer",
  sessionFollowUp: "rind/session/follow_up",
  sessionPromoteFollowUp: "rind/session/promote_follow_up",
  sessionUnsteer: "rind/session/unsteer",
  sessionDequeueFollowUp: "rind/session/dequeue_follow_up",
  sessionSubscribe: "session/subscribe",
  sessionUnsubscribe: "session/unsubscribe",
  sessionCompact: "rind/session/compact",
  modelList: "model/list",
  modelSet: "model/set",
  modelEffort: "model/effort",
  commandExecute: "rind/command/execute",
  userQuestionRespond: "rind/user-question/respond",
  goalGet: "rind/goal/get",
  goalSet: "rind/goal/set",
  goalStatus: "rind/goal/status",
  goalClear: "rind/goal/clear",
  fileList: "file/list",
  fileRead: "file/read",
  fileWrite: "file/write",
});

// Kernel model/effort vocabulary (model/effort accepts exactly these).
export const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export function parseSlashCommand(value) {
  const match = String(value || "").trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: String(match[2] || "").trim() } : null;
}

export function sessionIdOf(value) {
  return String(value?.id || value?.session_id || "").trim();
}

