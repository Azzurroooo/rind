import { organizationRows, sidebarRows, taskRows, teamSessions } from "../agents-model.js";
import { renderAgents } from "../agents-view.js";
import { renderReport } from "../agents-report.js";
import { createLineEditor } from "../line-editor.js";
import { CURSOR_MARKER } from "../tui/frame.js";

// Reuse the real projections and renderer, but never start a service or worker.
// The transient view may be mutated by rendering; the replayable scene may not.
export function renderTourAgents(scene, width, rows) {
  const { snapshot, page, selectedId, focus, now, reportTaskId, reportOffset = 0, dialog } = structuredClone(scene);
  const view = {
    snapshot, page, selectedId, focus, navId: page.teamId,
    sidebar: sidebarRows(snapshot), pageKey: `${page.kind}:${page.teamId}:${page.tab}`,
    entries: page.tab === "tasks" ? taskRows(snapshot, page.teamId)
      : [{ id: "add-member", kind: "add-member", title: "Add member", teamId: page.teamId },
        ...organizationRows(snapshot, page.teamId, teamSessions(snapshot, page.teamId), { now })],
    scroll: {}, query: "", filter: "All", connection: "connected", returnTo: { own: true },
  };
  if (dialog) view.dialog = { ...dialog, kind: "form", index: 0,
    fields: dialog.fields.map(field => ({ ...field, kind: "text", editor: createLineEditor(field.value), suggestions: [], pick: -1 })) };
  if (reportTaskId) {
    const task = snapshot.tasks.find(task => task.id === reportTaskId);
    const name = id => snapshot.agents.find(agent => agent.id === id)?.name || id;
    view.detail = {
      title: task.brief, offset: reportOffset,
      render: reportWidth => renderReport({
        task, team: snapshot.teams.find(team => team.id === task.teamId).name,
        owner: name(task.assigneeAgentId), name,
        artifacts: snapshot.artifacts.filter(artifact => artifact.taskId === task.id),
        runs: snapshot.runs.filter(run => run.taskId === task.id),
        subtasks: snapshot.tasks.filter(child => child.parentTaskId === task.id),
        decide: "a accept · w rework",
      }, reportWidth, { now }),
    };
  }
  // A filled form is watch-only; it must not take the tour's hardware cursor.
  return renderAgents(view, width, rows, now).map(line => line.replaceAll(CURSOR_MARKER, ""));
}
