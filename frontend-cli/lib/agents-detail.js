import { paint } from "./theme.js";
import { single, statusMeta, roleOf, needsUser, taskStatus, memberState } from "./agents-model.js";

const tone = status => (paint[statusMeta(status).tone] || paint.dim)(statusMeta(status).glyph + " " + status);
const field = (label, value) => [paint.dim(label), value || paint.dim("—"), ""];
function memberLine(row) {
  const { tone: status, label } = memberState(row.ownStatus || row.status, row.open);
  return (paint[statusMeta(status).tone] || paint.dim)(statusMeta(status).glyph + " " + label[0].toUpperCase() + label.slice(1));
}
const byId = (items, id) => items.find(item => item.id === id);

// Lines describing the selected row: what it is, its state, and what Enter does.
export function detailFor(view, row) {
  const { snapshot } = view;
  if (!row) return [];
  const agent = byId(snapshot.agents, row.agentId);
  const team = byId(snapshot.teams, row.teamId);
  switch (row.kind) {
    case "member": {
      const membership = snapshot.memberships.find(m => m.teamId === row.teamId && m.agentId === row.agentId);
      const parent = byId(snapshot.agents, membership?.reportsToAgentId);
      const tasks = snapshot.tasks.filter(t => t.teamId === row.teamId && t.assigneeAgentId === row.agentId);
      const current = tasks.find(t => t.status === "running") || tasks.find(needsUser) || tasks.findLast(t => t.status !== "cancelled");
      const position = single(membership?.position);
      const role = row.leader ? ["Leader", position].filter(Boolean).join(" · ") : roleOf(snapshot, row.teamId, row.agentId);
      return [paint.bold(row.title), paint.dim(role + (parent ? " · reports to " + single(parent.name) : row.leader ? " · reports to you" : "")), "",
        memberLine(row), "",
        ...field("Workspace", paint.path(agent?.canonicalWorkspace || "Unavailable")),
        ...field("Responsibility", single(membership?.responsibility) || paint.dim("Not assigned · press e")),
        ...(current ? field("Current task", single(current.brief) + "\n" + paint.dim(taskStatus(current) + (current.blockedOn ? " · " + single(current.blockedOn.action) : ""))) : []),
        ...field("Conversations", row.sessionCount ? row.sessionCount + " in this team" : paint.dim("None yet · press c to start one")),
        ...(row.reportCount ? field("Direct reports", String(row.reportCount)) : [])];
    }
    case "workspace": return [paint.bold(row.title), paint.dim(row.agentId ? "Registered folder" + (row.teams.length ? " · member of " + row.teams.join(", ") : "") : "Folder not in any team"), "",
      ...field("Folder", paint.path(row.workspace)),
      ...field("Conversations", row.sessionCount + (row.working ? " · " + row.working + " working" : "")),
      "Enter shows every conversation here; c starts a new one."];
    case "session":
    case "more":
    case "new-session": {
      if (row.independent) return [paint.bold(row.title), paint.dim(row.workspace), "",
        tone(row.status) + (row.time ? paint.dim(" · " + row.time) : ""), "",
        ...field("Session", paint.dim(row.sessionId)),
        "Enter continues this conversation in its folder. It stays outside every team."];
      if (row.manager) return [paint.bold("Manager"), paint.dim("Coordinates every team"), "", "Assembles teams, delegates to leaders and reviews published reports. Members' private conversations stay with them.", "", ...(row.kind === "session" ? field("Conversation", row.title) : [])];
      const task = byId(snapshot.tasks, row.taskId);
      const owner = paint.dim((single(agent?.name) || "Member") + " · " + (single(team?.name) || "Team"));
      if (row.kind === "more") return [paint.bold(row.title), owner, "", "Enter lists every conversation this member has in the team."];
      if (row.kind === "new-session") return [paint.bold(row.title), owner, "", "Opens a new conversation in this member's workspace. It stays attached to this team."];
      return [paint.bold(row.title), owner, "", tone(row.status) + (row.time ? paint.dim(" · " + row.time) : ""), "",
        ...(task ? field("Task", single(task.brief)) : []),
        ...field("Session", paint.dim(row.sessionId)),
        row.status === "Needs input" ? paint.warning("Waiting for your answer. Enter joins the conversation.") : "Enter joins this conversation in its workspace."];
    }
    case "approval": {
      const approval = (snapshot.approvals || []).find(item => item.id === row.approvalId);
      return [paint.bold(row.title.replace(/^Approve: /, "")), paint.dim(row.context), "", paint.warning("! The Manager asks for your approval"), "",
        approval?.kind === "deleteTeam" ? "Deleting keeps delivered work readable under Archive; folders and history are never touched." : "Stopping cancels the running task; its conversation is kept.", "",
        "Enter to approve or decline. Nothing happens until you decide."];
    }
    case "archive": return [paint.bold("Archive"), paint.dim("Deleted teams, read-only"), "", "What deleted teams delivered: reports, evidence and files. Nothing here can run or change.", "", "Enter lists them."];
    case "task": {
      if (row.archived) return [paint.bold(row.title), paint.dim("Owner: " + row.owner), "", tone(row.status), "", ...field("Delivery", row.note || paint.dim("No report")), paint.dim("Read-only: the team was deleted."), "", "Enter opens the report."];
      const task = byId(snapshot.tasks, row.taskId);
      if (!task) return [];
      return [paint.bold(single(task.brief)), paint.dim("Owner: " + row.owner + (task.priority ? " · " + task.priority + " priority" : "") + (task.parentTaskId ? " · subtask" : "")), "", tone(row.status), "",
        ...(task.queueReason && task.status === "queued" ? field("Queue", task.queueReason) : []),
        ...(task.blockedOn ? field(needsUser(task) ? "Needs your answer" : "Waiting on", single(task.blockedOn.action)) : []),
        ...(task.error ? field("Problem", single(task.error)) : []),
        ...(task.report ? field("Delivery · " + task.report.outcome, single(task.report.summary)) : field("Delivery", paint.dim("No report yet"))),
        ...(row.fresh ? [paint.accent("● New delivery. Open it to accept it or send it back."), ""] : task.review?.decision === "accepted" ? [paint.success("✓ Accepted"), ""] : task.review?.decision === "rework" ? [paint.warning("↺ Sent back for rework"), ""] : []),
        "Enter opens the report: outcome, evidence, files and history."];
    }
    case "team": {
      const leader = byId(snapshot.agents, team?.leaderAgentId);
      const s = row.summary;
      return [paint.bold(row.title), paint.dim("Leader: " + (single(leader?.name) || "not chosen yet")), "",
        ...field("Members", s.members + (s.working ? " · " + s.working + " working" : "")),
        ...field("Tasks", (s.needs ? paint.warning(s.needs + " need you") + " · " : "") + s.queued + " queued · " + s.delivered + " delivered"),
        ...field("New workspaces", paint.path(team?.createRoot || "")),
        "Enter opens the team; Space for more, including delete."];
    }
    case "inbox": return [paint.bold("Inbox"), paint.dim("Everything waiting on you, across teams"), "", "Answers, the Manager's requests for approval, unconfirmed runs and conversations that asked a question come first; then recent deliveries, with ● on the ones you have not reviewed."];
    case "background": return [paint.bold("Background"), paint.dim("What keeps running after you leave Rind"), "",
      "Leaving Rind (ctrl+c twice, or /exit) only closes windows. Agents, tasks and the shared Runtime keep working.", "",
      "Stop them here when you want everything to end."];
    case "live": return [paint.bold(row.title), paint.dim(row.context), "", tone(row.status) + paint.dim(" · started " + (row.time || "now") + " ago"), "",
      row.taskId ? "Enter opens the task delivery." : "Enter joins this conversation.", "",
      paint.dim("It keeps running if you leave Rind.")];
    case "service": return [paint.bold(row.title), paint.dim(row.note), "",
      row.id === "svc:management" ? "Keeps teams, tasks and their state, and schedules work. Starts on demand." : "Hosts every conversation of every Rind window, and every task, in isolated sessions. Starts when a conversation needs it.",
      ...(row.stale ? ["", paint.warning(row.id === "svc:management"
        ? "A newer Rind is installed. Restart this service to load it; conversations keep running."
        : "A newer Rind is installed. The Runtime keeps the old code while Rind windows use it, and updates by itself when the next window opens after they are all closed.")] : []),
      "", "Enter for actions and its log."];
    case "stop-all": return [paint.bold(row.title.replace("…", "")), "",
      row.working ? row.working + (row.working === 1 ? " agent is" : " agents are") + " working. Stopping cancels their running work." : "Nothing is running. This only stops the background services.", "",
      "Teams, members, tasks and conversation history are kept. Services start again when you next need them.", "",
      paint.dim("Leaving Rind never does this.")];
    case "independent": return [paint.bold("Independent"), paint.dim("Conversations outside any team"), "", "Every Rind conversation that is not part of a team, grouped by folder, with what is running or open right now.", "", "Enter lists them."];
    case "manager": return [paint.bold("Manager"), paint.dim("Coordinates every team"), "", "Assembles teams, delegates to leaders and reviews published reports. Members' private conversations stay with them.", "", "Enter lists Manager conversations."];
    case "new-team": return [paint.bold("Create a team"), "", "Name it, then add folders as members. The first member becomes the leader; others report to the leader unless you choose a supervisor."];
    case "add-member": return [paint.bold("Add a member"), "", "Use an existing folder, create an empty workspace, or create a Git worktree for parallel work.", "", row.firstMember ? "The first member becomes the team leader." : "New members report to the leader. To add someone below another member, select that member and press a."];
    case "assign": return [paint.bold("Assign a task"), "", "Choose an owner and describe the expected delivery. The owner reports back with a summary, evidence and artifacts."];
    case "run": return [paint.bold("Unconfirmed run"), paint.dim(row.context), "", "The host could not confirm whether the previous run stopped. Make sure its process ended, then release the workspace."];
    case "clear": return [paint.bold("All clear"), "", "Nothing is waiting on you."];
    default: return [];
  }
}
