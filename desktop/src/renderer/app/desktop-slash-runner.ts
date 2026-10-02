import { desktopSlashAction } from "../desktop-slash.ts"
import { clearSlashCommandPending } from "./composer.ts"
import { openInspector } from "./inspector.ts"
import { submitGoal } from "./inspector-goal.ts"
import { forkCurrentSession } from "./sessions.ts"
import { showToast } from "./overlays.ts"
import { render } from "./shell.ts"
import { state } from "./state.ts"

export async function runDesktopSlash(input: string): Promise<boolean> {
  const action = desktopSlashAction(input)
  if (!action) return false
  clearSlashCommandPending()
  if (action.type === "fork") {
    if (!state.viewedSessionId) showToast("Open a session to fork it.")
    else await forkCurrentSession()
  } else if (!action.objective) {
    await openInspector("activity")
    if (!state.goal.value) showToast("No goal set. Use /goal <objective> to set one.")
  } else if (!state.viewedSessionId) {
    showToast("Open a session before setting a goal.")
  } else {
    await submitGoal(action.objective)
  }
  render()
  return true
}
