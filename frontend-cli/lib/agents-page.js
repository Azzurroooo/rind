import { createTui } from "./tui/tui.js";
import { Component } from "./tui/component.js";
import { parseTerminalKey } from "./terminal-key.js";
import { truncateToWidth, wrapTextCells } from "./text-width.js";
import { managementClient, agentStatus } from "./agents-client.js";
import { openAgentChat } from "./agents-commands.js";

export function pageRows(snapshot, teamId, query = "", filter = "All", tasks = false) {
  const matching = text => text.toLowerCase().includes(query.toLowerCase());
  if (!teamId) return snapshot.teams.filter(t => matching(t.name)).map(t => {
    const statuses = snapshot.memberships.filter(m => m.teamId === t.id).map(m => agentStatus(snapshot, m.agentId, t.id));
    const leader = snapshot.agents.find(a => a.id === t.leaderAgentId);
    return { id: t.id, priority: Math.min(5, ...statuses.map(statusPriority)), text: t.name + " · " + statuses.length + " members · " + statuses.filter(s => s === "Working").length + " working · " + statuses.filter(s => ["Needs input", "Unconfirmed"].includes(s)).length + " need attention", detail: "Leader: " + (leader?.name || "Choose a leader") + " · New workspaces: " + t.createRoot };
  }).sort((a, b) => a.priority - b.priority);
  if (tasks) return snapshot.tasks.filter(t => t.teamId === teamId && matching(t.brief)).map(t => ({ id: t.id, text: t.status.padEnd(15) + " " + t.brief.replace(/\s+/g, " ").slice(0, 100) }));
  return snapshot.memberships.filter(m => m.teamId === teamId).flatMap(m => {
    const agent = snapshot.agents.find(a => a.id === m.agentId);
    const status = agentStatus(snapshot, m.agentId, teamId);
    if (!matching(agent.name + " " + (m.position || "") + " " + agent.canonicalWorkspace) || (filter !== "All" && filter !== status)) return [];
    return [{ id: agent.id, priority: statusPriority(status), text: status.padEnd(12) + " " + agent.name + " · " + (snapshot.teams.find(t => t.id === teamId)?.leaderAgentId === agent.id ? "Leader" : m.position || "Member"), detail: agent.canonicalWorkspace + (m.responsibility ? " · " + m.responsibility : "") }];
  }).sort((a, b) => a.priority - b.priority);
}
const statusPriority = status => ["Needs input", "Working", "Ready", "Unconfirmed", "Inactive"].indexOf(status);
export async function runAgentsPage({ launch, input = process.stdin, output = process.stdout, manageInput = true }) {
  const tui = createTui({ input, output, manageInput });
  let snapshot = { teams: [], memberships: [], agents: [], tasks: [], runs: [], sessions: [], notes: [], artifacts: [] };
  let teamId = "", selectedId = "", query = "", searching = false, filter = "All", tasks = false;
  let notice = "", form = null, busy = false, closed = false, detail = null, detailOffset = 0;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  function close() { closed = true; finish(); }
  let client, reconnecting;
  const connectionOptions = { ...launch, onSnapshot: value => { snapshot = value; tui.requestRender(); }, onDisconnect: () => {
    if (closed) return;
    notice = "Disconnected · status unconfirmed. Reconnecting…"; tui.requestRender();
    reconnecting = connect().catch(error => { notice = error.message + " · Esc to return."; tui.requestRender(); }).finally(() => { reconnecting = null; });
  } };
  async function connect() {
    const replacement = await managementClient(connectionOptions);
    if (closed) { replacement.close(); return; }
    client = replacement;
    snapshot = await client.request("subscribe", { afterSeq: snapshot.seq || 0 });
    notice = ""; tui.requestRender();
  }
  await connect();
  const rows = () => pageRows(snapshot, teamId, query, filter, tasks);
  const selected = () => rows().find(r => r.id === selectedId) || rows()[0];
  function formInput(title, fields, submit) { form = { title, fields, values: [], index: 0, value: "", submit }; }
  async function request(method, params) { if (reconnecting) await reconnecting; const result = await client.request(method, params); snapshot = await client.request("snapshot"); return result; }
  async function perform(action) {
    busy = true;
    try { await action(); }
    catch (error) { notice = error.message; }
    finally { busy = false; tui.requestRender(); }
  }
  async function addMember(workspace, position, responsibility, share = false) {
    try {
      const member = await request("addMember", { teamId, workspace, position, responsibility, share });
      if (!snapshot.teams.find(t => t.id === teamId).leaderAgentId) await request("setLeader", { teamId, agentId: member.agentId });
      notice = "Member added. First member becomes leader; select a member and press L to change.";
    } catch (error) {
      if (error.code !== "WORKSPACE_SHARED") throw error;
      formInput("Already in " + error.details.teams.join(", ") + ". Copy is recommended; share uses the same files.", ["Choice: copy / share (blank = copy)"], async ([choice]) => {
        if (choice.toLowerCase() === "share") return addMember(workspace, position, responsibility, true);
        if (choice && choice.toLowerCase() !== "copy") throw new Error("Choose copy or share.");
        formInput("Independent workspace", ["Directory name", "Git branch (blank = folder copy)"], async ([name, branch]) => {
          if (branch) {
            await request("createWorktree", { teamId, name, repository: workspace, branch, position, responsibility });
            return;
          }
          const preview = await client.request("previewCopy", { source: workspace });
          detail = ["Copy preview", "Files: " + preview.files.length + " · bytes: " + preview.bytes, "Excluded:", ...preview.excluded, "Included:", ...preview.files];
          formInput("Review copy: " + preview.files.length + " files, " + preview.bytes + " bytes. Excludes " + (preview.excluded.join(", ") || "none"), ["Type copy to confirm"], async ([confirmation]) => {
            detail = null;
            if (confirmation !== "copy") { notice = "Copy cancelled."; return; }
            await request("copyWorkspace", { teamId, name, source: workspace, confirmation: preview.fingerprint, position, responsibility });
          });
        });
      });
    }
  }
  async function openChat(manager = false) {
    const agent = snapshot.agents.find(a => a.id === selected()?.id);
    if (!manager && (!teamId || tasks || !agent)) return;
    tui.stop({ releaseInput: false });
    try { await openAgentChat({ agent, teamId, manager, launch, input }); }
    finally { tui.start({ acquireInput: false }); tui.replayAll(); }
  }
  async function taskDetails(taskId) {
    const task = await client.request("getTask", { taskId });
    detail = [
      task.brief, "Status: " + task.status, "",
      ...(task.report ? [task.report.summary, "", "Evidence", ...task.report.evidence, "", "Artifacts"] : []),
      ...await Promise.all((task.report?.artifacts || []).map(async id => {
        const artifact = await client.request("readArtifact", { artifactId: id });
        return artifact.name + ": " + artifact.path;
      })),
      task.blockedOn ? "Needs " + task.blockedOn.responder + ": " + task.blockedOn.action : "",
      task.error || "", "", "Notes", ...task.notes.map(n => n.author + ": " + n.text),
    ];
    detailOffset = 0;
  }
  function resolveUnknown(run) {
    if (!run) { notice = "No unconfirmed run is selected."; return; }
    formInput("Release this workspace only after confirming its old process has stopped.", ["Type stopped to confirm"], ([answer]) => answer === "stopped" ? request("resolveRun", { runId: run.id, confirmStopped: true }) : Promise.resolve());
  }
  class Screen extends Component {
    render(width) {
      const list = rows(), current = selected(), index = Math.max(0, list.findIndex(r => r.id === current?.id));
      const team = snapshot.teams.find(t => t.id === teamId);
      const lines = ["Agents Management" + (team ? " / " + team.name : ""), "M manager · N new team · / search · Esc back",
        team ? "A add folder · W workspace · G worktree · L leader · D assign · Tab members/tasks" : "↑↓ select · Enter open team · folders can be anywhere",
        "Search: " + query + (searching ? "▏" : "") + "  Filter: " + filter + " (F)", ""];
      if (form) lines.push(form.title, "", form.fields[form.index], "> " + form.value + "▏", "", "Enter next · Esc cancel");
      else if (detail) {
        const wrapped = detail.flatMap(line => String(line).split("\n").flatMap(part => wrapTextCells(part, width)));
        detailOffset = Math.min(detailOffset, Math.max(0, wrapped.length - 1));
        lines.push(...wrapped.slice(detailOffset, detailOffset + Math.max(3, tui.rows - 9)), "", "↑↓ scroll · Esc return");
      }
      else {
        const count = Math.max(3, tui.rows - 12), offset = Math.max(0, index - count + 1);
        for (const row of list.slice(offset, offset + count)) lines.push((row.id === current?.id ? "› " : "  ") + row.text);
        if (!list.length) lines.push(team ? "No members yet. Press A to add an existing folder." : "No teams yet. Press N to create your first team.");
        if (current?.detail) lines.push("", current.detail);
        if (team && !tasks && current) lines.push("", "Enter chat · X remove · U resolve unknown");
        if (tasks && current) {
          const task = snapshot.tasks.find(t => t.id === current.id);
          lines.push("", task.report?.summary || task.blockedOn?.action || task.error || "", "Enter delivery · R retry · S stop · C comment · U resolve unknown");
        }
      }
      lines.push("", busy ? "Working…" : notice || "Enter opens selected member · Q exits");
      return lines.slice(0, Math.max(1, tui.rows - 1)).map(line => truncateToWidth(String(line).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""), width));
    }
  }
  tui.addChild(new Screen());
  tui.onPaste(value => { if (form) form.value += value.replace(/[\r\n]/g, " "); else if (searching) query += value; tui.requestRender(); });
  tui.onData(sequence => {
    const key = parseTerminalKey(sequence);
    if (!key) return;
    if (key.ctrl && key.name === "c") { close(); return; }
    if (busy) return;
    if (form) {
      if (key.name === "escape") { form = null; detail = null; }
      else if (key.name === "backspace") form.value = [...form.value].slice(0, -1).join("");
      else if (key.kind === "text") form.value += key.text;
      else if (key.name === "enter") {
        const current = form; current.values.push(current.value.trim());
        if (++current.index === current.fields.length) { form = null; void perform(() => current.submit(current.values)); }
        else current.value = "";
      }
    } else if (detail) {
      if (key.name === "escape") detail = null;
      if (key.name === "up") detailOffset = Math.max(0, detailOffset - 1);
      if (key.name === "down") detailOffset += 1;
    } else if (searching) {
      if (key.name === "escape" || key.name === "enter") searching = false;
      else if (key.name === "backspace") query = [...query].slice(0, -1).join("");
      else if (key.kind === "text") query += key.text;
    } else {
      const current = selected(), list = rows();
      if (key.name === "up" || key.name === "down") {
        const index = list.findIndex(r => r.id === current?.id);
        selectedId = list[Math.max(0, Math.min(list.length - 1, index + (key.name === "up" ? -1 : 1)))]?.id || "";
      } else if (key.name === "escape") { if (teamId) { teamId = ""; tasks = false; selectedId = ""; } else close(); }
      else if (key.name === "tab" && teamId) { tasks = !tasks; selectedId = ""; }
      else if (key.name === "enter") {
        if (!teamId && current) { teamId = current.id; selectedId = ""; }
        else if (!tasks) void perform(() => openChat());
        else if (current) void perform(() => taskDetails(current.id));
      } else if (key.kind === "text") {
        const command = key.text.toLowerCase();
        if (command === "q") close();
        else if (command === "/") searching = true;
        else if (command === "f") { const filters = ["All", "Needs input", "Working", "Ready", "Inactive", "Unconfirmed"]; filter = filters[(filters.indexOf(filter) + 1) % filters.length]; }
        else if (command === "m") void perform(() => openChat(true));
        else if (command === "n") formInput("Create a team", ["Team name"], async ([name]) => { const team = await request("createTeam", { name }); teamId = team.id; selectedId = ""; });
        else if (teamId && command === "a") formInput("Add any existing folder", ["Workspace path", "Position (optional)", "Responsibility (optional)"], values => addMember(...values));
        else if (teamId && command === "w") formInput("New member workspace", ["Directory name"], ([name]) => request("createWorkspace", { teamId, name }));
        else if (teamId && command === "g") formInput("Feature worktree", ["Directory name", "Repository path", "New branch", "Base (blank = HEAD)"], ([name, repository, branch, base]) => request("createWorktree", { teamId, name, repository, branch, base: base || "HEAD" }));
        else if (teamId && !tasks && current && command === "l") void perform(() => request("setLeader", { teamId, agentId: current.id }));
        else if (teamId && !tasks && current && command === "x") formInput("Remove membership; keep workspace and history.", ["Type remove to confirm"], ([answer]) => answer === "remove" ? request("removeMember", { teamId, agentId: current.id }) : Promise.resolve());
        else if (teamId && !tasks && current && command === "u") resolveUnknown(snapshot.runs.find(r => r.status === "unknown" && snapshot.sessions.some(s => s.id === r.sessionId && s.agentId === current.id && s.teamId === teamId)));
        else if (teamId && !tasks && current && command === "d") formInput("Assign to " + snapshot.agents.find(a => a.id === current.id).name, ["Task and expected delivery"], ([brief]) => request("assignTask", { teamId, assigneeAgentId: current.id, brief }));
        else if (tasks && current && command === "r") void perform(() => request("startTask", { taskId: current.id }));
        else if (tasks && current && command === "c") {
          const answer = snapshot.tasks.find(t => t.id === current.id)?.blockedOn?.responder === "user";
          formInput(answer ? "Answer blocker and resume this task" : "Task note", ["Progress or unblocking answer"], ([text]) => request("postTaskNote", { taskId: current.id, text, answer }));
        }
        else if (tasks && current && command === "s") {
          const run = snapshot.runs.find(r => r.taskId === current.id && ["starting", "running"].includes(r.status));
          if (run) void perform(() => request("cancelRun", { runId: run.id }));
        } else if (tasks && current && command === "u") {
          const run = snapshot.runs.find(r => r.taskId === current.id && r.status === "unknown");
          resolveUnknown(run);
        }
      }
    }
    tui.requestRender();
  });
  input.on?.("end", close); input.on?.("close", close);
  try { if (!closed) { tui.start(); await finished; } }
  finally { closed = true; client.close(); tui.stop(); input.off?.("end", close); input.off?.("close", close); }
}
