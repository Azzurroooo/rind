export function isReadonlySlashCommand(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "/status" || text.startsWith("/status ") || text === "/doctor" || text.startsWith("/doctor ");
}

export function steeringCommandText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\/steer(?:\s+([\s\S]*))?$/i);
  return match ? String(match[1] || "").trim() : null;
}

export function parseGoalCommand(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  const argument = String(match[1] || "").trim();
  const action = argument.toLowerCase();
  if (!argument) {
    return { action: "get" };
  }
  if (["pause", "resume", "clear"].includes(action)) {
    return { action };
  }
  return { action: "set", objective: argument };
}
