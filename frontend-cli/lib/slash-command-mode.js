export function isReadonlySlashCommand(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "/status" || text.startsWith("/status ") || text === "/doctor" || text.startsWith("/doctor ");
}

export function steeringCommandText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\/steer(?:\s+([\s\S]*))?$/i);
  return match ? String(match[1] || "").trim() : null;
}
