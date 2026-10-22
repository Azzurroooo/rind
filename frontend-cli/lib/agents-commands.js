import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managementClient, overviewText } from "./agents-client.js";
import { createHandoff, HANDOFF_ENV } from "./agents-handoff.js";
import { applySavedTheme } from "./cli-state-store.js";
import { terminalKeyboard, TERMINAL_KEYBOARD_ENV } from "./tui/tui.js";
import { releaseInput, takeInput } from "./tui/console-input.js";
import { privateDirectory, resolveRindHome } from "../../rind-runtime-client/local-files.js";

export const agentsHelp = [
  "Usage: rind agents [list | stop | resolve | import] [--json]",
  "  (none)                            open the Agents page; without a terminal, same as list",
  "  list                              teams, members and tasks; --json gives the full state",
  "  stop [--all]                      stop background services when idle; --all also stops running agents",
  "  stop <run>                        stop one run",
  "  resolve <run> --confirm-stopped   release a run whose process has stopped",
  "  import <legacy-team-root> [--confirm] [--share]",
  "Teams and tasks are managed on the Agents page or by the Manager.",
].join("\n");

export const managerWorkspace = launch => path.join(resolveRindHome(launch?.home), "agents-management", "manager");

// Runs one conversation window and returns where the user went next:
// { action: "agents" | "leave" | "return" } or { action: "open", chat }.
// A conversation window replaces the one on screen; the window it replaces
// (or the shell) must not stay visible above it.
export function clearForConversation(output = process.stdout) {
  if (output.isTTY) output.write("\x1b[2J\x1b[H\x1b[3J");
}

export async function openAgentChat({ agent, teamId, manager = false, runtimeSessionId, prefill, launch, input = process.stdin, windowScript = fileURLToPath(new URL("../bin/rind.js", import.meta.url)) }) {
  const raw = input.isRaw;
  // Stopped before it leaves raw mode, or a read left pending would take the
  // keys typed into the conversation.
  releaseInput(input);
  // The conversation owns the terminal and handles ctrl+c itself. A signal that
  // reaches this window too (while the child is between terminal modes) must
  // not end it, or the child would be left without its opener.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const handoff = await createHandoff();
  try {
    const cwd = manager ? managerWorkspace(launch) : agent.canonicalWorkspace;
    if (manager) await privateDirectory(cwd);
    const args = manager ? ["--manager"] : ["--cwd", cwd, ...(teamId ? ["--team", teamId] : ["--standalone"])];
    if (runtimeSessionId) args.push("--session", runtimeSessionId);
    if (prefill) args.push("--prefill", prefill);
    clearForConversation();
    // Where the window says to go next: leave, open another conversation, or Agents.
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [windowScript, ...args], {
        cwd,
        stdio: "inherit", windowsHide: true, env: { ...process.env, RIND_HOME: launch.home || process.env.RIND_HOME, RIND_PYTHON: launch.python || process.env.RIND_PYTHON, RIND_RUNTIME_PATH: launch.runtimePath || "", [HANDOFF_ENV]: handoff.file, [TERMINAL_KEYBOARD_ENV]: terminalKeyboard() },
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
  } finally { process.off("SIGINT", ignore); await handoff.dispose(); if (raw) takeInput(input); }
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
  try {
    while (next.action === "open") { last = next.chat; next = (await open({ ...next.chat, launch, input })) || { action: "return" }; }
    return { ...next, chat: last };
  } finally { applySavedTheme(launch?.home); }
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

// The command line only observes and recovers: teams and tasks change on the
// Agents page or through the Manager, never from a script acting as the user.
export async function runAgentsCommand(args, launch) {
  const json = args.includes("--json");
  args = args.filter(arg => arg !== "--json");
  if (args.includes("--help") || args.includes("-h")) { console.log(agentsHelp); return; }
  // A session's shell would act as the user and bypass delegate, report and agent_management.
  if (process.env.RIND_SHARED_HOST_PID) throw new Error("`rind agents` acts as the user and cannot run inside a Rind session. Run it in a terminal outside Rind.");
  if (!args.length && process.stdin.isTTY && process.stdout.isTTY) {
    const { runAgentsPage } = await import("./agents-page.js");
    const result = await runAgentsPage({ launch, standalone: true });
    if (result.leave) console.log(leaveSummary(result));
    exitInteractive();
  }
  const [command = "list", target, ...rest] = args;
  if (command === "stop" && (!target || target === "--all")) { await stopBackground(target === "--all", launch, json); return; }
  if (!["list", "stop", "resolve", "import"].includes(command) || (command !== "list" && !target)) throw new Error(agentsHelp);
  const client = await managementClient(launch);
  try {
    let result;
    if (command === "list") {
      result = await client.request("snapshot");
      if (!json) { console.log(overviewText(result)); return; }
    } else if (command === "stop") result = await client.request("cancelRun", { runId: target });
    else if (command === "resolve") result = await client.request("resolveRun", { runId: target, confirmStopped: rest.includes("--confirm-stopped") });
    else {
      // The service runs in its own folder, so the folder is resolved here, where the user typed it.
      const root = path.resolve(target);
      const preview = await client.request("previewImport", { root });
      result = rest.includes("--confirm") ? await client.request("importTeam", { root, confirmation: preview.fingerprint, share: rest.includes("--share") }) : preview;
    }
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
      if (error.code === "UNKNOWN_METHOD") result = await stopLegacy(client, all, launch);
      else if (all && error.code !== "SERVICE_BUSY") {
        client.close();
        await stopRuntimeAlone(all, launch, json);
        return;
      } else throw error;
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
  const { stopManagementService } = await import("../../agent-management/dist/client.js");
  const { connectSharedRuntime, stopSharedRuntime } = await import("../../rind-runtime-client/shared-runtime.js");
  const stoppedService = all ? await stopManagementService({ home: launch?.home }).catch(() => false) : false;
  const host = await connectSharedRuntime({ rindHome: launch?.home, start: false }).catch(() => null);
  if (!host) {
    const stoppedRuntime = all ? await stopSharedRuntime({ rindHome: launch?.home }).catch(() => false) : false;
    if (stoppedService || stoppedRuntime) { console.log(json ? JSON.stringify({ stopped: true, working: 0 }) : "Stopped the background services."); return; }
    console.log(json ? JSON.stringify({ stopped: false, running: false }) : "Background services are not running.");
    return;
  }
  try {
    const info = await host.request("runtime/info").catch(() => null);
    if (!info && all) {
      host.close();
      await stopSharedRuntime({ rindHome: launch?.home });
      console.log(json ? JSON.stringify({ stopped: true, working: 0 }) : "Stopped the background services.");
      return;
    }
    const working = info?.busy || 0;
    if (working && !all) {
      process.exitCode = 1;
      console.log(json ? JSON.stringify({ stopped: false, working }) : working + (working === 1 ? " conversation is" : " conversations are") + " still working.\nRun `rind agents stop --all` to stop them too.");
      return;
    }
    await host.request("runtime/shutdown").catch(() => {});
    host.close();
    if (all) await stopSharedRuntime({ rindHome: launch?.home });
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
  const { stopSharedRuntime } = await import("../../rind-runtime-client/shared-runtime.js");
  await stopSharedRuntime({ rindHome: launch.home });
  return { stopping: true, working: result.working };
}

// Like a chat window, an interactive page ends the process itself: on Windows,
// once a conversation window has used the same console, waiting for the
// console input to close on its own can block until another key arrives.
function exitInteractive() { process.exit(process.exitCode ?? 0); }
