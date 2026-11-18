import { clientRuntimeMethods } from "../../runtime/dist/protocol/runtime-protocol.js";

export const methods = Object.freeze({
  initialize: "initialize",
  ...clientRuntimeMethods,
  sessionUnsubscribe: "session/unsubscribe",
  agentsGet: "agents/get",
  agentsRequest: "agents/request",
  agentsOpenSession: "agents/openSession",
  agentsCreateSession: "agents/createSession",
  workspaceDirs: "workspace/dirs",
});

export function parseSlashCommand(value) {
  const match = String(value || "").trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: String(match[2] || "").trim() } : null;
}

export function sessionIdOf(value) {
  return String(value?.id || value?.session_id || "").trim();
}
