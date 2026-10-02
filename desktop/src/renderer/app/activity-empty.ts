import { activePlan } from "../timeline-model.ts"
import { requiredElement } from "./dom.ts"
import { state } from "./state.ts"

/** One empty state for the whole Activity tab, updated by goals and task polls. */
export function renderActivityEmpty() {
  const monitor = state.taskMonitor
  const empty = requiredElement("activity-empty")
  empty.hidden = Boolean(activePlan(state.conversation) || state.goal.value || monitor.tasks.length || monitor.error || state.conversation.backgroundWait?.count)
  if (empty.hidden) return
  const loading = Boolean(state.viewedSessionId && !monitor.loaded && monitor.refreshing)
  requiredElement("activity-empty-title").textContent = loading ? "Loading activity" : state.viewedSessionId ? "No active work" : "No activity yet"
  requiredElement("activity-empty-description").textContent = loading
    ? "Checking this session for running tasks."
    : state.viewedSessionId
      ? "Plans and running tasks appear here. Completed output stays in the conversation."
      : "Start a conversation to see its plan and running tasks here."
}
