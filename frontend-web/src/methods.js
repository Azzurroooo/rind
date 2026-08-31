export const methods = Object.freeze({
  initialize: "initialize",
  sessionList: "session/list",
  sessionNew: "session/new",
  sessionSwitch: "session/switch",
  sessionReplay: "session/replay",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSteer: "rind/session/steer",
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
});

export const slashCommands = [
  ["status", "Session status"],
  ["sessions", "Switch session"],
  ["model", "Change model"],
  ["effort", "Reasoning effort"],
  ["compact", "Compact context"],
  ["goal", "Manage active goal"],
  ["help", "Show commands"],
  ["doctor", "Run diagnostics"],
  ["init", "Draft RIND.md"],
  ["skill", "List skills"],
  ["team", "Manage Team"],
  ["config", "Show configuration"],
  ["login", "Login setup"],
];

export function parseSlashCommand(value) {
  const match = String(value || "").trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: String(match[2] || "").trim() } : null;
}

export function sessionIdOf(value) {
  return String(value?.id || value?.session_id || "").trim();
}

