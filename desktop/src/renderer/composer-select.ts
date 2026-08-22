export function modelChoices(models: string[], currentModel: string) {
  const choices: string[] = []
  const seen = new Set<string>()
  for (const value of [currentModel, ...models]) {
    const model = value.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    choices.push(model)
  }
  return choices
}

export function modelSelectionTarget(status: "starting" | "ready" | "stopping" | "error" | "stopped", turnActive: boolean) {
  if (status === "starting" || status === "stopping" || turnActive) return "unavailable" as const
  return status === "ready" ? "runtime" as const : "settings" as const
}
