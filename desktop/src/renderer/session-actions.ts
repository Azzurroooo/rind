/** Export the complete replay without the timeline's display limits. */
export function replayMarkdown(messages: unknown[], title: string) {
  const sections = messages.flatMap((message) => {
    const item = message && typeof message === "object" ? message as Record<string, unknown> : {}
    if (item.role !== "user" && item.role !== "assistant") return []
    const content = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n") : ""
    return content ? [`## ${item.role === "user" ? "You" : "Rind"}\n\n${content}`] : []
  })
  return `# ${title}\n\n${sections.join("\n\n")}`
}

export function restoreFailedDraft(drafts: Record<string, string>, key: string, text: string) {
  drafts[key] = [text, drafts[key]].filter(Boolean).join("\n")
  return drafts[key]
}
