import { desktopSlashAction } from "../desktop-slash.ts"
import { clearSlashCommandPending } from "./composer.ts"
import { openGoalTab } from "./inspector.ts"
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
    await openGoalTab()
  } else if (!state.viewedSessionId) {
    showToast("Open a session before setting a goal.")
  } else {
    state.goal = { ...state.goal, draft: action.objective }
    await submitGoal()
  }
  render()
  return true
}
