// What the right-hand panel says about the selected row, as the parts
// renderPanel draws (see agents-panel.js): the most important facts first, at
// most one callout, and no prose about keys (the footer lists them).
import { paint } from "./theme.js";
import { single, statusMeta, roleOf, needsUser, taskStatus, memberState, sessionSelection, jobSummary } from "./agents-model.js";
import { renderPanel } from "./agents-panel.js";

const toned = (status, text) => (paint[statusMeta(status).tone] || paint.dim)(statusMeta(status).glyph + " " + text);
const stateLine = (status, time) => toned(status, status) + (time ? paint.dim(" · " + time) : "");
const byId = (items, id) => items.find(item => item.id === id);

const SESSION_SOURCES = { session: "this conversation", folder: "folder default", main_repository: "main repository", settings: "settings.json" };
const FOLDER_SOURCES = { folder: "this folder", main_repository: "main repository", settings: "settings.json" };
// "model folder default · effort this conversation", or one source when both agree.
function sources(names, model, effort) {
  if (!model) return "";
  return paint.dim(!effort || names[model] === names[effort] ? names[model] : "model " + names[model] + " · effort " + names[effort]);
}
const runsOn = (provider, model, effort) => single(provider) + " / " + single(model) + (effort ? " · " + single(effort) : "");
const notConfigured = (provider, what) => ({ text: "! " + single(provider) + " is not configured · " + what + " · /login", tone: "warning" });

// A conversation: its saved or live selection. A folder: what new conversations there start with.
function sessionRunsOn(selection) {
  if (!selection) return {};
  const { provider, model, reasoningEffort, selectionSource = {}, connectionReady } = selection;
  return {
    fact: { label: "Runs on", value: [runsOn(provider, model, reasoningEffort), sources(SESSION_SOURCES, selectionSource.model, reasoningEffort && selectionSource.effort)] },
    callout: connectionReady === false ? notConfigured(provider, "its next turn fails") : undefined,
  };
}
function folderRunsOn(resolved, label) {
  if (!resolved) return {};
  const { provider, model, reasoning_effort: effort, model_source: modelSource, effort_source: effortSource, connection_ready: ready } = resolved;
  return {
    fact: { label, value: [runsOn(provider, model, effort), sources(FOLDER_SOURCES, modelSource, effort && effortSource)] },
    callout: ready === false ? notConfigured(provider, "new conversations fail") : undefined,
  };
}
function jobText(snapshot, runtimeSessionId) {
  const background = (snapshot.live || []).find(item => item.id === runtimeSessionId)?.background;
  return background?.count ? jobSummary(background) + paint.dim(" · continues by itself") : "";
}
const first = (...callouts) => callouts.find(Boolean);

export function detailFor(view, row) {
  const { snapshot } = view;
  if (!row) return null;
  const agent = byId(snapshot.agents, row.agentId);
  const team = byId(snapshot.teams, row.teamId);
  switch (row.kind) {
    case "member": {
      const membership = snapshot.memberships.find(m => m.teamId === row.teamId && m.agentId === row.agentId);
      const parent = byId(snapshot.agents, membership?.reportsToAgentId);
      const tasks = snapshot.tasks.filter(t => t.teamId === row.teamId && t.assigneeAgentId === row.agentId);
      const current = tasks.find(t => t.status === "running") || tasks.find(needsUser) || tasks.findLast(t => t.status !== "cancelled");
      const role = row.leader ? ["Leader", single(membership?.position)].filter(Boolean).join(" · ") : roleOf(snapshot, row.teamId, row.agentId);
      const { tone, label } = memberState(row.ownStatus || row.status, row.open);
      const model = folderRunsOn(view.folderDefaults?.[agent?.canonicalWorkspace], "Runs on");
      return {
        title: row.title, context: role + (parent ? " · reports to " + single(parent.name) : row.leader ? " · reports to you" : ""),
        state: toned(tone, label[0].toUpperCase() + label.slice(1)),
        callout: first(current && needsUser(current) && current.blockedOn && { text: "! Needs your answer · " + single(current.blockedOn.action) }, model.callout),
        facts: [
          model.fact,
          current && { label: "Task", value: [single(current.brief), paint.dim(taskStatus(current))], lines: 3 },
          { label: "Owns", value: single(membership?.responsibility) },
          { label: "Folder", value: paint.path(agent?.canonicalWorkspace || "") },
          { label: "Team", value: [row.sessionCount ? row.sessionCount + (row.sessionCount === 1 ? " conversation" : " conversations") : "", row.reportCount ? row.reportCount + (row.reportCount === 1 ? " direct report" : " direct reports") : ""].filter(Boolean).join(" · ") },
        ],
      };
    }
    case "workspace": {
      const model = folderRunsOn(view.folderDefaults?.[row.workspace], "Defaults");
      return {
        title: row.title, context: row.agentId ? "Registered folder" + (row.teams.length ? " · member of " + row.teams.join(", ") : "") : "Folder not in any team",
        callout: model.callout,
        facts: [model.fact, { label: "Chats", value: row.sessionCount + (row.working ? " · " + row.working + " working" : "") }, { label: "Path", value: paint.path(row.workspace) }],
      };
    }
    case "session": {
      const model = sessionRunsOn(sessionSelection(view, row.sessionId));
      const task = byId(snapshot.tasks, row.taskId);
      const waiting = row.status === "Needs input" && { text: "! Waiting for your answer", tone: "warning" };
      return {
        title: row.title,
        context: row.manager ? "Manager conversation" : row.independent ? row.workspace : (single(agent?.name) || "Member") + " · " + (single(team?.name) || "Team"),
        state: stateLine(row.status, row.time),
        callout: first(waiting, model.callout),
        facts: [model.fact, task && { label: "Task", value: single(task.brief), lines: 3 }, { label: "Job", value: jobText(snapshot, row.sessionId) }, { label: "Session", value: paint.dim(row.sessionId) }],
      };
    }
    case "more": return { title: row.title, context: (single(agent?.name) || "Member") + " · " + (single(team?.name) || "Team"), text: ["Every conversation this member has in the team."] };
    case "new-session": return row.manager
      ? { title: row.title, context: "Coordinates every team", text: ["Assembles teams, delegates to leaders and reviews their reports."] }
      : row.workspace ? { title: row.title, context: row.workspace, text: ["Outside every team."] }
      : { title: row.title, context: (single(agent?.name) || "Member") + " · " + (single(team?.name) || "Team"), text: ["In this member's workspace, attached to this team."] };
    case "live": {
      const model = sessionRunsOn(row.sessionId && sessionSelection(view, row.sessionId));
      const task = byId(snapshot.tasks, row.taskId);
      return {
        title: row.title, context: row.context,
        state: stateLine(row.status, row.time && "running " + row.time),
        callout: first(row.status === "Needs input" && { text: "! Waiting for your answer", tone: "warning" }, model.callout),
        facts: [
          { label: task ? "Task" : "Doing", value: task ? single(task.brief) : single(row.note).split(" · ")[0], lines: 3 },
          { label: "Job", value: jobText(snapshot, row.sessionId) },
          model.fact,
        ],
        text: [paint.dim("Keeps running if you leave Rind.")],
      };
    }
    case "task": {
      const task = byId(snapshot.tasks, row.taskId);
      if (row.archived) return { title: row.title, titleLines: 3, context: "Owner " + row.owner + " · read-only, the team was deleted", state: stateLine(row.status), facts: [{ label: "Delivery", value: row.note || paint.dim("No report"), lines: 3 }] };
      if (!task) return null;
      const asked = task.blockedOn && !needsUser(task);
      const review = row.fresh ? { text: "● New delivery · open it to accept or send back", tone: "accent" }
        : task.review?.decision === "accepted" ? { text: "✓ Accepted", tone: "success" } : task.review?.decision === "rework" ? { text: "↺ Sent back for rework", tone: "warning" } : undefined;
      return {
        title: single(task.brief), titleLines: 3,
        context: ["Owner " + row.owner, task.priority && task.priority + " priority", task.parentTaskId && "subtask"].filter(Boolean).join(" · "),
        state: stateLine(row.status),
        callout: first(needsUser(task) && task.blockedOn && { text: "! Needs your answer · " + single(task.blockedOn.action) }, task.error && { text: "! " + single(task.error) }, review),
        facts: [
          asked && { label: task.blockedOn.responder === "children" ? "Waits on" : "Asked", value: (task.blockedOn.responder === "children" ? "its members · " : (single(byId(snapshot.agents, task.blockedOn.responder)?.name) || "a member") + " · ") + single(task.blockedOn.action) },
          task.status === "queued" && { label: "Queue", value: task.queueReason },
          { label: "Delivery", value: task.report ? [paint.dim(task.report.outcome), single(task.report.summary)] : paint.dim("No report yet"), lines: 4 },
        ],
      };
    }
    case "approval": {
      const approval = (snapshot.approvals || []).find(item => item.id === row.approvalId);
      return { title: row.title.replace(/^Approve: /, ""), context: row.context, callout: { text: "! The Manager asks for your approval" },
        text: [approval?.kind === "deleteTeam" ? "Delivered work stays readable under Archive; folders and history are never touched." : "The running task is cancelled; its conversation is kept."] };
    }
    case "notice": return { title: row.title, context: row.context, text: ["Applies from the member's next task; running work keeps its model."] };
    case "team": {
      const leader = byId(snapshot.agents, team?.leaderAgentId);
      const s = row.summary;
      return {
        title: row.title, context: "Leader " + (single(leader?.name) || "not chosen yet"),
        callout: s.needs ? { text: "! " + s.needs + (s.needs === 1 ? " task needs you" : " tasks need you") } : undefined,
        facts: [
          { label: "Members", value: s.members + (s.working ? " · " + s.working + " working" : "") },
          { label: "Tasks", value: s.queued + " queued · " + s.delivered + " delivered" },
          { label: "New in", value: paint.path(team?.createRoot || "") },
        ],
      };
    }
    case "run": return { title: "Unconfirmed run", context: row.context, callout: { text: "! Make sure its process ended, then release the workspace" } };
    case "service": return {
      title: row.title, context: row.note,
      callout: row.stale ? { text: row.id === "svc:management" ? "! A newer Rind is installed · restart to load it; conversations keep running" : "! A newer Rind is installed · updates when every window has closed" } : undefined,
      text: [row.id === "svc:management" ? "Keeps teams, tasks and their state, and schedules work. Starts on demand." : "Hosts every conversation and task. Starts when a conversation needs it."],
    };
    case "stop-all": return {
      title: row.title.replace("…", ""),
      callout: row.working ? { text: row.working + (row.working === 1 ? " agent is" : " agents are") + " working · their running work is cancelled", tone: "danger" } : undefined,
      text: [row.working ? "" : "Nothing is running. This only stops the background services.", "Teams, members, tasks and history are kept. Leaving Rind never does this."].filter(Boolean),
    };
    case "inbox": return { title: "Inbox", context: "Everything waiting on you", text: ["Answers, the Manager's requests and questions first; then recent deliveries, ● on the ones you have not reviewed."] };
    case "background": return { title: "Background", context: "What keeps running after you leave", text: ["Leaving Rind only closes windows. Agents, tasks and the shared Runtime keep working until you stop them here."] };
    case "independent": return { title: "Independent", context: "Conversations outside any team", text: ["Grouped by folder, with what is running or open now."] };
    case "manager": return { title: "Manager", context: "Coordinates every team", text: ["Assembles teams, delegates to leaders and reviews their reports. Members' private conversations stay with them."] };
    case "archive": return { title: "Archive", context: "Deleted teams, read-only", text: ["What deleted teams delivered: reports, evidence and files."] };
    case "new-team": return { title: "Create a team", text: ["Name it, then add folders as members. The first member leads; others report to the leader unless you choose a supervisor."] };
    case "add-member": return { title: "Add a member", text: ["An existing folder, a new empty workspace, or a Git worktree for parallel work.", row.firstMember ? "The first member becomes the team leader." : "New members report to the leader; select a member and press a to add below it."] };
    case "assign": return { title: "Assign a task", text: ["Choose an owner and describe the delivery. The owner reports back with a summary, evidence and files."] };
    case "clear": return { title: "All clear", text: ["Nothing is waiting on you."] };
    default: return null;
  }
}

// The panel for `row` as lines, `width` wide and at most `height` tall.
export function detailLines(view, row, width, height) {
  return renderPanel(detailFor(view, row), width, height);
}
