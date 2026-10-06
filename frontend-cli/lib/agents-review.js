import { readFile } from "node:fs/promises";
import { single } from "./agents-model.js";
import { renderReport } from "./agents-report.js";

const PREVIEW_BYTES = 256 * 1024;

// A published file shown in place; binary or very large files are only named.
async function preview(file) {
  try {
    const data = await readFile(file.path);
    if (data.length > PREVIEW_BYTES || data.includes(0)) return [file.path, "", "This file is not shown here (binary or larger than 256 KiB). Open it from the path above."];
    return [file.path, "", ...data.toString("utf8").split(/\r?\n/)];
  } catch (error) { return [file.path, "", "Could not read the file: " + error.message]; }
}

// Delivery reports, reviewing them, deleting teams and the Manager's requests
// for approval: the flows that decide what happens to finished work.
export function createReviewActions(ui, { agentName, display, teamOf, assignTask, taskActions, answer }) {
  const snap = () => ui.view.snapshot;
  const archivedTeam = teamId => ui.view.archive?.teams?.find(team => team.id === teamId);
  const name = (task, id) => archivedTeam(task.teamId)?.archive?.members?.[id] || display(id);

  async function delivery(taskId) {
    const task = await ui.request("getTask", { taskId });
    const archive = archivedTeam(task.teamId);
    const archived = Boolean(archive || snap().archivedTeams?.some(team => team.id === task.teamId));
    const artifacts = await Promise.all((task.report?.artifacts || []).map(artifactId => ui.request("readArtifact", { artifactId })));
    const tasks = archive?.tasks || snap().tasks;
    const report = {
      task, archived, artifacts,
      team: teamOf(task.teamId)?.name || archive?.name || "Team",
      owner: name(task, task.assigneeAgentId),
      runs: snap().runs.filter(run => run.taskId === taskId),
      subtasks: tasks.filter(child => child.parentTaskId === taskId),
      name: id => name(task, id),
    };
    const delivered = task.status === "done" && !task.review && !archived;
    const owner = !archived && snap().memberships.some(m => m.teamId === task.teamId && m.agentId === task.assigneeAgentId);
    const blocked = task.status === "blocked" && task.blockedOn?.responder === "user";
    const actions = [
      ...(delivered ? [{ key: "a", label: "accept", run: () => ui.run(() => accept(task)) }, { key: "b", label: "send back", run: () => sendBack(task, report.owner) }] : []),
      ...(!archived ? [{ key: "n", label: blocked ? "answer" : "add note", run: () => answer(taskId) }] : []),
      ...(artifacts.length || owner ? [{ key: "o", label: artifacts.length ? "open files" : "conversations", run: () => openFrom(task, artifacts, owner) }] : []),
      ...(task.notes.length || report.runs.length || report.subtasks.length ? [{ key: "z", label: "history", run: detail => { detail.expanded = !detail.expanded; } }] : []),
      ...(!archived ? [{ key: "space", label: "more actions", run: () => taskActions(taskId) }] : []),
      { key: "r", label: "refresh", run: () => ui.run(() => delivery(taskId), "Refreshing…") },
    ];
    ui.showReport(single(task.brief), { render: (width, detail) => renderReport(report, width, { expanded: detail.expanded }), actions, refresh: () => delivery(taskId) });
  }

  async function accept(task) {
    await ui.request("reviewTask", { taskId: task.id, decision: "accept" });
    ui.notify("Accepted. It is no longer marked new.", "success");
  }

  function sendBack(task, owner) {
    ui.form("Send back for rework", [{ key: "feedback", label: "What should change", hint: owner + " gets a new task with this feedback and the delivery you reviewed; this report stays as it is." }],
      async ({ feedback }) => {
        await ui.request("reviewTask", { taskId: task.id, decision: "rework", feedback });
        ui.notify("Sent back to " + owner + " as a new task.", "success");
      }, { description: [single(task.brief)] });
  }

  // Files open in place; the owner's conversations are one step away.
  function openFrom(task, artifacts, owner) {
    const back = () => ui.run(() => delivery(task.id));
    const items = [
      ...artifacts.map(file => ({ label: single(file.name), description: file.size + " bytes", action: async () => ui.showText(single(file.name), await preview(file), { back }) })),
      ...(owner ? [{ label: "Conversations of " + agentName(task.assigneeAgentId), key: "c", description: "Talk to the owner in their workspace", action: () => ui.openMember(task.teamId, task.assigneeAgentId) }] : []),
    ];
    if (!artifacts.length) return items[0].action();
    ui.choose("Open", items);
  }

  function teamActions(teamId) {
    const team = teamOf(teamId);
    if (!team) return;
    ui.choose(single(team.name), [
      { label: "Open team", key: "enter", action: () => ui.openTeam(teamId) },
      { label: "Assign task", key: "t", description: "Give the leader a tracked task", action: () => assignTask(teamId) },
      { label: "Delete team…", key: "x", danger: true, description: "Folders and history are kept", action: () => deleteTeam(teamId) },
    ]);
  }

  function deleteTeam(teamId) {
    const team = teamOf(teamId);
    const tasks = snap().tasks.filter(task => task.teamId === teamId);
    const sessions = new Set(snap().sessions.filter(s => s.teamId === teamId).map(s => s.id));
    const running = snap().runs.filter(run => sessions.has(run.sessionId) && ["starting", "running", "unknown"].includes(run.status)).length;
    if (running) { ui.notify("Stop or resolve the team's " + running + " running " + (running === 1 ? "task" : "tasks") + " before deleting it.", "error"); return; }
    const unfinished = tasks.filter(task => !["done", "cancelled"].includes(task.status)).length;
    const members = snap().memberships.filter(m => m.teamId === teamId).length;
    const teamName = single(team.name);
    ui.form("Delete " + teamName + "?", [{ key: "confirmName", label: "Team name", hint: "Type " + teamName + " to confirm.", validate: value => value === team.name ? "" : "Type " + teamName + " exactly to delete it." }],
      async ({ confirmName }) => {
        const result = await ui.request("deleteTeam", { teamId, confirmName });
        ui.notify(teamName + " deleted." + (result.archived ? " Its deliveries are in Archive." : ""), "success");
      }, { danger: true, description: [
        members + (members === 1 ? " member is" : " members are") + " released" + (unfinished ? " and " + unfinished + " unfinished " + (unfinished === 1 ? "task is" : "tasks are") + " cancelled." : "."),
        tasks.length ? "Delivered work stays readable, read-only, under Archive." : "The team has no tasks, so nothing is archived.",
        "Folders, their files and conversation history are never touched.",
      ] });
  }

  function approval(approvalId) {
    const request = snap().approvals?.find(item => item.id === approvalId);
    if (!request) return;
    const team = single(teamOf(request.teamId)?.name || "the team");
    const description = request.kind === "deleteTeam"
      ? ["The Manager asks to delete " + team + ".", "Unfinished tasks are cancelled and members released; delivered work stays readable under Archive. Folders and history are never touched."]
      : ["The Manager asks to stop running work in " + team + ":", single(request.title.replace(/^Stop /, "")), "The task is cancelled; its conversation is kept."];
    const resolve = approve => async () => {
      const result = await ui.request("resolveApproval", { approvalId, approve });
      ui.notify(result.expired ? "That request no longer applies." : approve ? "Approved." : request.taskId ? "Declined. The task notes tell the Manager." : "Declined.", result.expired ? "info" : "success");
    };
    ui.choose(single(request.title) + "?", [
      { label: "Decline", key: "n", description: "Nothing changes", action: resolve(false) },
      { label: request.kind === "deleteTeam" ? "Delete team" : "Stop the task", key: "y", danger: true, action: resolve(true) },
    ], { description, danger: true });
  }

  return { delivery, teamActions, deleteTeam, approval };
}
