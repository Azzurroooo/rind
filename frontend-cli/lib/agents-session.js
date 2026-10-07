import { existsSync } from "node:fs";
import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { managementClient, selectRecord } from "./agents-client.js";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// The folder a conversation lives in. The shared Runtime knows every session it
// runs, including a new one with nothing saved yet; saved history covers the
// rest. A custom history folder (--session-dir) is never the shared Runtime's.
export async function sessionWorkspace(home, sessionId, sessionDir = "") {
  if (!SESSION_ID.test(sessionId) || sessionId.includes("..")) throw new Error("Invalid session ID.");
  const host = sessionDir ? null : await connectSharedRuntime({ rindHome: home, start: false }).catch(() => null);
  if (host) {
    try {
      const live = (await host.request("runtime/sessions").catch(() => ({ sessions: [] }))).sessions?.find(item => item.id === sessionId);
      if (live?.workspace) return live.workspace;
    } finally { host.close(); }
  }
  const meta = await readFile(path.join(sessionDir || path.join(home, "sessions"), sessionId, "meta.json"), "utf8").then(JSON.parse, () => null);
  return typeof meta?.workspace_root === "string" ? meta.workspace_root : "";
}

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
  if (manager && remaining.some(arg => arg === "--cwd" || arg === "--dir")) throw new Error("Manager uses its dedicated workspace; omit --cwd/--dir.");
  return { args: remaining, team, standalone, manager, prefill };
}
// A conversation outside every team is a plain session: no agent, no
// management scope. Interactive windows still run it in the shared Runtime,
// so every window and the Agents page see it live, and leaving a window does
// not stop its work. Scripts keep a private worker that ends with them, and
// options the shared host cannot honour per window keep it private too.
export async function plainSession(args, interactive, home) {
  const sharedOk = interactive && !args.includes("--trace-llm") && !argument(args, "--session-dir");
  if (!sharedOk) return { args, shared: false };
  // The shared Runtime opens a conversation in a folder, so resuming one from
  // elsewhere names the folder it lives in (a private worker read it itself).
  const resume = argument(args, "--session");
  if (resume && !argument(args, "--cwd") && !argument(args, "--dir") && SESSION_ID.test(resume) && !resume.includes("..")) {
    const workspace = await sessionWorkspace(home, resume);
    if (workspace) return { args: ["--cwd", workspace, ...args], shared: true };
  }
  return { args, shared: true };
}

export async function prepareManagement(args, launch, { interactive = !!process.stdin.isTTY, chooseTeam } = {}) {
  const options = managementArgs(args);
  const root = path.resolve(launch.home || process.env.RIND_HOME || path.join(os.homedir(), ".rind"), "agents-management");
  const rindHome = path.dirname(root);
  if (!options.manager && !options.team && !existsSync(path.join(root, "state", "user-token"))) return plainSession(options.args, interactive, rindHome);
  let client, session, runtimeSessionId = "", reconnecting, detached = false, disconnected = false;
  const connectionOptions = { ...launch, onDisconnect: () => {
    if (detached) return;
    disconnected = true;
    process.stderr.write("Agents management disconnected; verifying runtime activity before reconnecting.\n");
    void reconnect().catch(error => process.stderr.write(error.message + "\n"));
  } };
  // Reattach to a service that is restarting, but never start one: after an
  // explicit stop this conversation simply continues untracked.
  function reconnect() {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      for (let attempt = 0; attempt < 20 && !detached; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          const replacement = await managementClient({ ...connectionOptions, start: false });
          if (detached) { replacement.close(); return; }
          client = replacement;
          disconnected = false;
          return;
        } catch {}
      }
      if (!detached) throw new Error("Agents management is stopped; this conversation is no longer tracked. Reopen it from Agents to track it again.");
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  }
  try {
    client = await managementClient(connectionOptions);
  } catch (error) {
    if (options.standalone) return plainSession(options.args, interactive, rindHome);
    throw error;
  }
  try {
    const snapshot = await client.request("snapshot");
    let workspace = options.manager ? path.join(root, "manager") : path.resolve(argument(options.args, "--cwd") || argument(options.args, "--dir") || process.cwd());
    let resumeId = argument(options.args, "--session");
    let registeredSession = resumeId && snapshot.sessions.find(s => s.runtimeSessionId === resumeId);
    if (registeredSession && !options.manager && !argument(options.args, "--cwd") && !argument(options.args, "--dir")) workspace = snapshot.agents.find(a => a.id === registeredSession.agentId).canonicalWorkspace;
    if (resumeId && !registeredSession) {
      // A conversation without saved history (a new one) is checked by the Runtime when it opens.
      const known = await sessionWorkspace(rindHome, resumeId, argument(options.args, "--session-dir"));
      if (known) {
        const explicitWorkspace = options.manager || argument(options.args, "--cwd") || argument(options.args, "--dir");
        const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
        const canonical = value => realpath(value).then(normalize, () => { throw new Error("The folder of that conversation no longer exists: " + value); });
        if (explicitWorkspace && await canonical(workspace) !== await canonical(known)) throw new Error("That conversation belongs to another workspace. Open its member from Agents management.");
        workspace = known;
      }
    }
    workspace = await realpath(workspace);
    if (process.platform === "win32") workspace = workspace.toLowerCase();
    const agent = snapshot.agents.find(a => a.canonicalWorkspace === workspace && a.adapter === "rind");
    if (!agent && !options.manager) {
      if (options.team) throw new Error("This directory is not registered. Add it from Agents management first.");
      client.close(); return plainSession(options.args, interactive, rindHome);
    }
    if (options.args.includes("--trace-llm")) throw new Error("Shared Runtime tracing is host-wide. Set RIND_TRACE_LLM=1 before starting the shared host instead of --trace-llm.");
    const sessionDir = argument(options.args, "--session-dir");
    if (sessionDir && path.resolve(sessionDir) !== path.resolve(path.dirname(root), "sessions")) throw new Error("Shared conversations use RIND_HOME/sessions. Set RIND_HOME to select another shared history directory; omit --session-dir.");
    if (!resumeId && agent && (options.args.includes("--resume-latest") || options.args.includes("-c"))) {
      const history = await client.request("listSessions", { agentId: agent.id });
      resumeId = history.sessions[0]?.runtimeSessionId;
      if (resumeId) {
        registeredSession = snapshot.sessions.find(s => s.runtimeSessionId === resumeId);
        options.args = [...options.args.filter(arg => !["--resume-latest", "-c"].includes(arg)), "--session", resumeId];
      }
    }
    let team;
    const teams = snapshot.teams.filter(t => snapshot.memberships.some(m => m.teamId === t.id && m.agentId === agent?.id));
    if (options.team) team = selectRecord(teams, options.team, "Workspace team");
    else if (!options.standalone && registeredSession) team = teams.find(t => t.id === registeredSession.teamId);
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
    session = await client.request("attachSession", { agentId: agent?.id, teamId: team?.id, manager: options.manager, runtimeSessionId: resumeId, shared: true });
    const externalTools = await client.request("sessionTools", { sessionId: session.id });
    const runtimeArgs = !argument(options.args, "--cwd") && !argument(options.args, "--dir") ? ["--cwd", workspace, ...options.args] : options.args;
    return {
      chatContext: { agent, teamId: team?.id, manager: options.manager },
      prefill: options.prefill,
      shared: true, args: runtimeArgs, externalTools, label: options.manager ? "Manager" : team ? "Team: " + team.name : "Independent member session",
      async bind(info) {
        if (runtimeSessionId && info.session_id !== runtimeSessionId) throw new Error("Open another registered session in a separate rind process.");
        runtimeSessionId = info.session_id;
        await client.request("bindSession", { sessionId: session.id, runtimeSessionId });
      },
      async before(method, params) {
        if (reconnecting || disconnected) await reconnect();
        if (["session/new", "session/switch"].includes(method)) throw new Error("Use Agents management to open another member, or start a separate rind session.");
        if (params?.session_id && runtimeSessionId && params.session_id !== runtimeSessionId) throw new Error("This process is attached to another registered runtime session.");
      },
      // A window opened on a conversation binds at once; a new one when its
      // first message creates the conversation.
      async after(method, result) {
        if (["initialize", "session/create"].includes(method) && result?.session_id) await this.bind(result);
      },
      async close() {
        if (detached) return; detached = true;
        try { await client.request("detachSession", { sessionId: session.id }); }
        finally { client.close(); }
      },
    };
  } catch (error) { client.close(); throw error; }
}
function argument(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }

export function observeRuntime(client, management) {
  if (!management.before) return client;
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
