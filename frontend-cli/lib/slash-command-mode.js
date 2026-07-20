export function isReadonlySlashCommand(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "/status" || text.startsWith("/status ") || text === "/doctor" || text.startsWith("/doctor ");
}
