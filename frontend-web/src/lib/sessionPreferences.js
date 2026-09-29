const prefix = "rind.surface.";
export function readPreference(key, fallback = "") {
  try { return sessionStorage.getItem(prefix + key) ?? fallback; } catch { return fallback; }
}
export function writePreference(key, value) {
  try { if (value) sessionStorage.setItem(prefix + key, value); else sessionStorage.removeItem(prefix + key); } catch { /* Storage is optional. */ }
}
export function exportConversation(messages, title = "Rind conversation") {
  const contentText = (value) => Array.isArray(value) ? value.map((part) => typeof part === "string" ? part : part?.text || "").join("\n") : String(value || "");
  const text = `# ${title}\n\n` + messages.filter((m) => m.content && ["user", "assistant"].includes(m.role)).map((m) => `## ${m.role === "user" ? "You" : "Rind"}\n\n${contentText(m.content)}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "rind-conversation.md"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
