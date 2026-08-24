import { join, resolve } from "node:path"

import { readJsonObject } from "./json-store.ts"

export function projectSettingsPath(workspace: string) {
  return join(resolve(workspace), ".rind", "settings.json")
}

export async function loadSettingsForWorkspace(userPath: string, workspace = "") {
  const userSettings = await readJsonObject(userPath)
  if (!workspace) return userSettings
  try {
    const projectSettings = await readJsonObject(projectSettingsPath(workspace))
    if (hasCompleteProjectSettings(projectSettings)) return projectSettings
  } catch {
    // An invalid project file falls back to the user settings.
  }
  return userSettings
}

export function hasCompleteProjectSettings(settings: Record<string, unknown>) {
  const apiKey = stringSetting(settings.apiKey)
  const baseUrl = stringSetting(settings.baseUrl)
  const model = stringSetting(settings.model)
  try {
    const url = new URL(baseUrl)
    return Boolean(apiKey && model && url.hostname && (url.protocol === "http:" || url.protocol === "https:"))
  } catch {
    return false
  }
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}
