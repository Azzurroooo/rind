import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { managementClient, overviewText, selectRecord } from "./agents-client.js";
import { createHandoff, HANDOFF_ENV } from "./agents-handoff.js";
import { terminalKeyboard, TERMINAL_KEYBOARD_ENV } from "./tui/tui.js";

export const agentsHelp = [
  "Usage: rind agents [list | team | task | open | manager | import] [--json]",
  "  team create <name> [--root <existing-directory>]",
  "  team add <team> <workspace> [--share] [--position <name>] [--responsibility <text>]",
  "  team leader <team> <agent> | team remove <team> <agent>",
  "  team reports-to <team> <agent> <supervisor>",
  "  sessions <team>[/<agent>] | sessions manager",
  "  team workspace <team> <name>",
  "  team worktree <team> <name> <repository> <branch> [base]",
  "  team copy <team> <name> <source> [--confirm <preview-fingerprint>]",
  "  task <team> <agent> <brief>",
  "  show <task> | start <task> | cancel <task> | priority <task> high|normal|low",
  "  note <task> <text> [--answer]",
  "  stop <run> | resolve <run> --confirm-stopped",
  "  artifact <artifact-id>",
  "  open <team>/<agent> | manager",
  "  import <legacy-team-root> [--confirm] [--share]",
  "  stop [--all]   stop background services when idle; --all also stops running agents",
  "Names and unique ID prefixes are accepted. Shared directories require an explicit choice.",
].join("\n");

export const managerWorkspace = launch => path.resolve(launch.home || process.env.RIND_HOME || path.join(os.homedir(), ".rind"), "agents-management", "manager");

// Runs one conversation window and returns where the user went next:
// { action: "agents" | "leave" | "return" } or { action: "open", chat }.
// A conversation window replaces the one on screen; the window it replaces
// (or the shell) must not stay visible above it.
export function clearForConversation(output = process.stdout) {
  if (output.isTTY) output.write("\x1b[2J\x1b[H\x1b[3J");
}

export async function openAgentChat({ agent, teamId, manager = false, runtimeSessionId, prefill, launch, input = process.stdin, windowScript = fileURLToPath(new URL("../bin/rind.js", import.meta.url)) }) {
  const raw = input.isRaw;
  // Paused before it leaves raw mode: on Windows a read left pending across
  // the switch would take the keys typed into the conversation.
  input.pause?.();
  input.setRawMode?.(false);
  // The conversation owns the terminal and handles ctrl+c itself. A signal that
  // reaches this window too (while the child is between terminal modes) must
  // not end it, or the child would be left without its opener.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const handoff = await createHandoff();
  try {
    const args = manager ? ["--manager"] : ["--cwd", agent.canonicalWorkspace, ...(teamId ? ["--team", teamId] : ["--standalone"])];
    if (runtimeSessionId) args.push("--session", runtimeSessionId);
    if (prefill) args.push("--prefill", prefill);
    clearForConversation();
    // Where the window says to go next: leave, open another conversation, or Agents.
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [windowScript, ...args], {
        cwd: manager ? managerWorkspace(launch) : agent.canonicalWorkspace,
        stdio: "inherit", windowsHide: true, env: { ...process.env, RIND_HOME: launch.home || process.env.RIND_HOME, RIND_PYTHON: launch.python || "python", RIND_RUNTIME_PATH: launch.runtimePath || "", [HANDOFF_ENV]: handoff.file, [TERMINAL_KEYBOARD_ENV]: terminalKeyboard() },
      });
      child.once("error", reject);
      child.once("close", code => resolve(code));
    }).then(async code => {
      const next = await handoff.read();
      // A window that failed without saying where to go reports the failure.
      if (next.action === "failed") throw new Error(next.error);
      if (code !== 0 && next.action === "return") throw new Error("The conversation window closed unexpectedly (exit " + code + ").");
      return next;
    });
  } finally { process.off("SIGINT", ignore); await handoff.dispose(); input.setRawMode?.(!!raw); input.resume?.(); }
}

// The last line Rind prints when its windows close.
export function leaveSummary({ working = 0, notice = "" } = {}) {
  if (notice) return notice;
  return working > 0 ? "Left Rind · " + working + (working === 1 ? " agent keeps" : " agents keep") + " working in the background. Run `rind agents` to check on them." : "Left Rind.";
}

// Follows conversation-to-conversation moves until the user goes back to
// Agents, returns, or leaves Rind. `chat` is the last conversation opened.
export async function followConversation(chat, { launch, input, open = openAgentChat }) {
  let next = { action: "open", chat };
  let last = chat;
  while (next.action === "open") { last = next.chat; next = (await open({ ...next.chat, launch, input })) || { action: "return" }; }
  return { ...next, chat: last };
}

// The conversation the user just left, so Esc on the Agents page goes back to
// it. Windows never stack: this is a place to reopen, not a window kept open.
export function returnTarget(next) {
  if (!["agents", "return"].includes(next?.action) || !next.chat) return null;
  // A window left before its first message comes back as a new conversation there.
  const runtimeSessionId = next.from ? next.from.runtimeSessionId || undefined : next.chat.runtimeSessionId;
  const { agent, teamId, manager } = next.chat;
  const workspace = next.from?.workspace || agent?.canonicalWorkspace;
  if (!runtimeSessionId && !workspace && !manager) return null;
  return { agentId: agent?.id, teamId, manager: Boolean(manager), workspace, runtimeSessionId };
}
// The service runs in its own folder, so a relative folder is resolved here,
// where the user typed it.
const folder = value => (value ? path.resolve(value) : value);
export async function runAgentsCommand(args, launch) {
  const json = args.includes("--json");
  args = args.filter(arg => arg !== "--json");
  if (args.includes("--help") || args.includes("-h")) { console.log(agentsHelp); return; }
  if (!args.length && process.stdin.isTTY && process.stdout.isTTY) {
    const { runAgentsPage } = await import("./agents-page.js");
    const result = await runAgentsPage({ launch, standalone: true });
    if (result.leave) console.log(leaveSummary(result));
    exitInteractive();
  }
  if (args[0] === "stop") { await stopBackground(args.includes("--all"), launch, json); return; }
  const client = await managementClient(launch);
  try {
    const snapshot = await client.request("snapshot");
    const team = value => selectRecord(snapshot.teams, value, "Team");
    const agent = (value, teamId) => selectRecord(snapshot.agents.filter(a => !teamId || snapshot.memberships.some(m => m.teamId === teamId && m.agentId === a.id)), value, "Agent");
    let result;
    const [command, sub, ...rest] = args;
    if (!command || command === "list") { result = snapshot; if (!json) { console.log(overviewText(snapshot)); return; } }
    else if (command === "manager") { await showConversation({ manager: true }, launch); return; }
    else if (command === "sessions") {
      const [teamValue, agentValue] = (sub || "").split("/");
      if (teamValue === "manager" && !agentValue) result = await client.request("listSessions", { manager: true });
      else {
        const selectedTeam = team(teamValue);
        result = await client.request("listSessions", { teamId: selectedTeam.id, ...(agentValue ? { agentId: agent(agentValue, selectedTeam.id).id } : {}) });
      }
    }
    else if (command === "open") {
      const [teamValue, agentValue] = (sub || "").split("/");
      const selectedTeam = team(teamValue);
      await showConversation({ agent: agent(agentValue, selectedTeam.id), teamId: selectedTeam.id, runtimeSessionId: option(rest, "--session") }, launch); return;
    } else if (command === "team") {
      if (sub === "create") result = await client.request("createTeam", { name: rest.slice(0, rest.includes("--root") ? rest.indexOf("--root") : rest.length).join(" "), createRoot: folder(option(rest, "--root")) });
      else {
        const selected = team(rest[0]);
        if (sub === "add") {
          result = await client.request("addMember", { teamId: selected.id, workspace: folder(rest[1]), share: rest.includes("--share"), position: option(rest, "--position"), responsibility: option(rest, "--responsibility") });
        }
        else if (sub === "leader" || sub === "remove") result = await client.request(sub === "leader" ? "setLeader" : "removeMember", { teamId: selected.id, agentId: agent(rest[1], selected.id).id });
        else if (sub === "reports-to") result = await client.request("setSupervisor", { teamId: selected.id, agentId: agent(rest[1], selected.id).id, reportsToAgentId: agent(rest[2], selected.id).id });
        else if (sub === "workspace") result = await client.request("createWorkspace", { teamId: selected.id, name: rest[1] });
        else if (sub === "worktree") result = await client.request("createWorktree", { teamId: selected.id, name: rest[1], repository: folder(rest[2]), branch: rest[3], base: rest[4] });
        else if (sub === "copy") {
          const preview = await client.request("previewCopy", { source: folder(rest[2]) });
          const confirmation = option(rest, "--confirm");
          result = confirmation ? await client.request("copyWorkspace", { teamId: selected.id, name: rest[1], source: folder(rest[2]), confirmation }) : preview;
        } else throw new Error(agentsHelp);
      }
    } else if (command === "task") {
      const selected = team(sub);
      result = await client.request("assignTask", { teamId: selected.id, assigneeAgentId: agent(rest[0], selected.id).id, brief: rest.slice(1).join(" ") });
    } else if (["show", "start", "note", "cancel", "priority"].includes(command)) {
      const task = selectRecord(snapshot.tasks, sub, "Task");
      result = await client.request({ show: "getTask", start: "startTask", note: "postTaskNote", cancel: "cancelTask", priority: "setTaskPriority" }[command], { taskId: task.id, ...(command === "note" ? { text: rest.filter(s => s !== "--answer").join(" "), answer: rest.includes("--answer") } : {}), ...(command === "priority" ? { priority: rest[0] } : {}) });
    } else if (command === "stop") result = await client.request("cancelRun", { runId: sub });
    else if (command === "resolve") result = await client.request("resolveRun", { runId: sub, confirmStopped: rest.includes("--confirm-stopped") });
    else if (command === "artifact") result = await client.request("readArtifact", { artifactId: sub });
    else if (command === "import") {
      const { importLegacyTeam } = await import("./agents-import.js");
      result = await importLegacyTeam({ client, root: folder(sub), confirm: rest.includes("--confirm"), share: rest.includes("--share"), launch });
    } else throw new Error(agentsHelp);
    console.log(JSON.stringify(result, null, 2));
  } finally { client.close(); }
}
// Stopping is explicit and separate from leaving Rind. Without --all it only
// stops services that have nothing running, so no work is lost by accident.
async function stopBackground(all, launch, json) {
  let client;
  try { client = await managementClient({ ...launch, start: false }); }
  catch { await stopRuntimeAlone(all, launch, json); return; }
  try {
    let result;
    try { result = await client.request("serviceShutdown", { stopAgents: all }); }
    catch (error) {
      if (error.code !== "UNKNOWN_METHOD") throw error;
      result = await stopLegacy(client, all, launch);
    }
    console.log(json ? JSON.stringify({ stopped: true, ...result }) : all && result.working ? "Stopped " + result.working + (result.working === 1 ? " running agent" : " running agents") + " and the background services." : "Stopped the background services.");
  } catch (error) {
    if (error.code !== "SERVICE_BUSY") throw error;
    process.exitCode = 1;
    console.log(json ? JSON.stringify({ stopped: false, ...error.details }) : error.message + "\nRun `rind agents stop --all` to stop them too.");
  } finally { client.close(); }
}

// Plain conversations start the shared Runtime without the management service;
// stopping must reach it too, under the same rule: running turns need --all.
async function stopRuntimeAlone(all, launch, json) {
  const { connectSharedRuntime } = await import("../../rind-runtime-client/shared-runtime.js");
  const host = await connectSharedRuntime({ rindHome: launch.home, start: false }).catch(() => null);
  if (!host) { console.log(json ? JSON.stringify({ stopped: false, running: false }) : "Background services are not running."); return; }
  try {
    const info = await host.request("runtime/info").catch(() => ({ busy: 0 }));
    const working = info.busy || 0;
    if (working && !all) {
      process.exitCode = 1;
      console.log(json ? JSON.stringify({ stopped: false, working }) : working + (working === 1 ? " conversation is" : " conversations are") + " still working.\nRun `rind agents stop --all` to stop them too.");
      return;
    }
    await host.request("runtime/shutdown").catch(() => {});
    console.log(json ? JSON.stringify({ stopped: true, working }) : all && working ? "Stopped " + working + (working === 1 ? " running conversation" : " running conversations") + " and the background services." : "Stopped the background services.");
  } finally { host.close(); }
}

// A service from before serviceShutdown: end its process once its own
// snapshot shows nothing running (or --all), then stop the Runtime it used.
async function stopLegacy(client, all, launch) {
  const { endLegacyService } = await import("../../agent-management/dist/client.js");
  const result = await endLegacyService(client, launch.home, { force: all });
  if (!result.ended && result.working) throw Object.assign(new Error(result.working + (result.working === 1 ? " agent is" : " agents are") + " still working."), { code: "SERVICE_BUSY", details: { working: result.working } });
  if (!result.ended) throw new Error("A background service from an older Rind is running but its process could not be found.");
  const { connectSharedRuntime } = await import("../../rind-runtime-client/shared-runtime.js");
  const host = await connectSharedRuntime({ rindHome: launch.home, start: false }).catch(() => null);
  if (host) { await host.request("runtime/shutdown").catch(() => {}); host.close(); }
  return { stopping: true, working: result.working };
}

// `rind agents open|manager`: going back from the conversation shows Agents.
async function showConversation(chat, launch) {
  const next = await followConversation(chat, { launch, input: process.stdin });
  if (next.action !== "agents") exitInteractive();
  const { runAgentsPage } = await import("./agents-page.js");
  const result = await runAgentsPage({ launch, standalone: true, initialTeamId: chat.teamId, returnTo: returnTarget(next) });
  if (result.leave) console.log(leaveSummary(result));
  exitInteractive();
}
// Like a chat window, an interactive page ends the process itself: on Windows,
// once a conversation window has used the same console, waiting for the
// console input to close on its own can block until another key arrives.
function exitInteractive() { process.exit(process.exitCode ?? 0); }
function option(args, flag) { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; }
