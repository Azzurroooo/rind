import { existsSync } from "node:fs";
import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { managementClient, selectRecord } from "./agents-client.js";

export function managementArgs(args) {
  const remaining = []; let team, standalone = false, manager = false, prefill;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--team") { if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--team requires a team ID or name."); team = args[++i]; }
    else if (args[i] === "--standalone") standalone = true;
    else if (args[i] === "--manager") manager = true;
    else if (args[i] === "--prefill") { if (args[i + 1] === undefined) throw new Error("--prefill requires text."); prefill = args[++i]; }
    else remaining.push(args[i]);
  }
  if ((team && standalone) || (manager && (team || standalone))) throw new Error("Choose one of --team, --standalone or --manager.");
  return { args: remaining, team, standalone, manager, prefill };
}
export async function prepareManagement(args, launch, { interactive = !!process.stdin.isTTY, chooseTeam } = {}) {
  const options = managementArgs(args);
  const root = path.resolve(launch.home || process.env.RIND_HOME || path.join(os.homedir(), ".rind"), "agents-management");
  if (!options.manager && !options.team && !existsSync(path.join(root, "state", "user-token"))) return { args: options.args };
  let client, runtime, session, runtimeSessionId = "", reconnecting, detached = false, disconnected = false;
  const connectionOptions = { ...launch, onDisconnect: () => {
    if (detached) return;
    disconnected = true;
    process.stderr.write("Agents management disconnected; verifying runtime activity before reconnecting.\n");
    void reconnect().catch(error => process.stderr.write(error.message + "\n"));
  } };
  function reconnect() {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      const replacement = await managementClient(connectionOptions);
      try {
        if (session && runtimeSessionId && runtime) {
          const replay = await runtime.request("session/replay", { session_id: runtimeSessionId });
          await replacement.request("reattachSession", { sessionId: session.id, runtimeSessionId, active: replay.live_turn?.status === "running" || replay.tasks?.some(task => ["starting", "running", "cancelling"].includes(task.status)) });
        }
        if (detached) { replacement.close(); return; }
        client = replacement;
        disconnected = false;
      } catch (error) { replacement.close(); throw error; }
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  }
  try {
    client = await managementClient(connectionOptions);
  } catch (error) {
    if (options.standalone) return { args: options.args };
    throw error;
  }
  try {
    const snapshot = await client.request("snapshot");
    let workspace = options.manager ? path.join(root, "manager") : path.resolve(argument(options.args, "--cwd") || argument(options.args, "--dir") || process.cwd());
    const resumeId = argument(options.args, "--session");
    if (resumeId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(resumeId) || resumeId.includes("..")) throw new Error("Invalid session ID.");
      const sessions = argument(options.args, "--session-dir") || path.join(path.dirname(root), "sessions");
      const metadata = JSON.parse(await readFile(path.join(sessions, resumeId, "meta.json"), "utf8"));
      if (metadata.workspace_root) {
        const explicitWorkspace = options.manager || argument(options.args, "--cwd") || argument(options.args, "--dir");
        const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
        if (explicitWorkspace && normalize(await realpath(workspace)) !== normalize(await realpath(metadata.workspace_root))) throw new Error("That conversation belongs to another workspace. Open its member from /agents.");
        workspace = metadata.workspace_root;
      }
    }
    workspace = await realpath(workspace);
    if (process.platform === "win32") workspace = workspace.toLowerCase();
    const agent = snapshot.agents.find(a => a.canonicalWorkspace === workspace && a.adapter === "rind");
    if (!agent && !options.manager) {
      if (options.team) throw new Error("This directory is not registered. Add it from /agents first.");
      client.close(); return { args: options.args };
    }
    let team;
    const teams = snapshot.teams.filter(t => snapshot.memberships.some(m => m.teamId === t.id && m.agentId === agent?.id));
    if (options.team) team = selectRecord(teams, options.team, "Workspace team");
    else if (!options.standalone && teams.length === 1) team = teams[0];
    else if (!options.standalone && teams.length > 1 && !options.manager) {
      if (!interactive) throw new Error("This workspace belongs to multiple teams. Use --team <id> or --standalone.");
      const choose = chooseTeam || (async choices => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { console.log(choices.map((t, i) => (i + 1) + ". " + t.name).join("\n") + "\n0. Independent session"); return await rl.question("Team for this session: "); }
        finally { rl.close(); }
      });
      const answer = String(await choose(teams));
      if (answer !== "0") { team = teams[Number(answer) - 1]; if (!team) throw new Error("Select a listed team, or 0 for an independent session."); }
    }
    session = await client.request("attachSession", { agentId: agent?.id, teamId: team?.id, manager: options.manager });
    const externalTools = await client.request("sessionTools", { sessionId: session.id });
    if (!options.manager) externalTools.instructions = [
      agent.hint || "", "Current team: " + (team?.name || "independent session") + ".",
      team ? "Team ID: " + team.id + "; Agent ID: " + agent.id + ". Use agent_management for registered team collaboration. Call snapshot for the roster. Tasks and published reports are visible to the team; private conversation stays here." : "This conversation has no team authority.",
      snapshot.memberships.find(m => m.agentId === agent?.id && m.teamId === team?.id)?.responsibility || "",
      agent.skillRefs?.length ? "Use assigned skills: " + agent.skillRefs.join(", ") : "",
    ].filter(Boolean).join("\n");
    const runtimeArgs = options.manager ? ["--cwd", workspace, ...options.args] : options.args;
    let queue = Promise.resolve();
    return {
      setRuntime(value) { runtime = value; },
      chatContext: { agent, teamId: team?.id, manager: options.manager },
      prefill: options.prefill,
      args: runtimeArgs, externalTools, label: options.manager ? "Manager" : team ? "Team: " + team.name : "Independent member session",
      async bind(info) {
        if (runtimeSessionId && info.session_id !== runtimeSessionId) throw new Error("Open another registered session in a separate rind process.");
        runtimeSessionId = info.session_id;
        await client.request("bindSession", { sessionId: session.id, runtimeSessionId });
      },
      async before(method, params) {
        if (reconnecting || disconnected) await reconnect();
        if (["session/new", "session/switch"].includes(method)) throw new Error("Use /agents to open another member, or start a separate rind session.");
        if (params?.session_id && runtimeSessionId && params.session_id !== runtimeSessionId) throw new Error("This process is attached to another registered runtime session.");
      },
      async after(method, result) {
        if (method === "initialize") await this.bind(result);
      },
      event(message) {
        if (message.event?.type !== "user_question_requested") return;
        queue = queue.catch(() => {}).then(async () => {
          const view = await client.request("snapshot");
          const run = view.runs.find(r => r.sessionId === session.id && ["starting", "running"].includes(r.status));
          if (run) await client.request("reportRunEvent", { sessionId: session.id, runId: run.id, hostSequence: run.hostSequence + 1, type: "needs_input" });
        });
        queue.catch(error => process.stderr.write(error.message + "\n"));
      },
      async close() {
        if (detached) return; detached = true;
        try { await queue; await client.request("detachSession", { sessionId: session.id }); }
        finally { client.close(); }
      },
    };
  } catch (error) { client.close(); throw error; }
}
function argument(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }

export function observeRuntime(client, management) {
  if (!management.before) return client;
  management.setRuntime(client);
  return {
    ...client,
    get child() { return client.child; },
    async request(method, params = {}) {
      await management.before(method, params);
      const result = await client.request(method, method === "session/prompt" ? { ...params, completion_scope: "request" } : params);
      await management.after(method, result);
      return result;
    },
    async shutdown() { try { await client.shutdown(); } finally { await management.close(); } },
  };
}
