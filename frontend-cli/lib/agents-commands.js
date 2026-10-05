import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { managementClient, overviewText, selectRecord } from "./agents-client.js";

export const agentsHelp = [
  "Usage: rind agents [list | team | task | open | manager | import] [--json]",
  "  team create <name> [--root <existing-directory>]",
  "  team add <team> <workspace> [--share] [--position <name>] [--responsibility <text>]",
  "  team leader <team> <agent> | team remove <team> <agent>",
  "  team workspace <team> <name>",
  "  team worktree <team> <name> <repository> <branch> [base]",
  "  team copy <team> <name> <source> [--confirm <preview-fingerprint>]",
  "  task <team> <agent> <brief>",
  "  show <task> | start <task> | note <task> <text>",
  "  stop <run> | resolve <run> --confirm-stopped",
  "  artifact <artifact-id>",
  "  open <team>/<agent> | manager",
  "  import <legacy-team-root> [--confirm] [--share]",
  "Names and unique ID prefixes are accepted. Shared directories require an explicit choice.",
].join("\n");

export async function openAgentChat({ agent, teamId, manager = false, runtimeSessionId, prefill, launch, input = process.stdin }) {
  const raw = input.isRaw;
  input.setRawMode?.(false);
  input.pause?.();
  try {
    const args = manager ? ["--manager"] : ["--cwd", agent.canonicalWorkspace, ...(teamId ? ["--team", teamId] : ["--standalone"])];
    if (runtimeSessionId) args.push("--session", runtimeSessionId);
    if (prefill) args.push("--prefill", prefill);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/rind.js", import.meta.url)), ...args], {
        stdio: "inherit", windowsHide: true, env: { ...process.env, RIND_HOME: launch.home || process.env.RIND_HOME, RIND_PYTHON: launch.python || "python", RIND_RUNTIME_PATH: launch.runtimePath || "" },
      });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error("Agent session exited with " + code)));
    });
  } finally { input.setRawMode?.(!!raw); input.resume?.(); }
}
export async function runAgentsCommand(args, launch) {
  const json = args.includes("--json");
  args = args.filter(arg => arg !== "--json");
  if (args.includes("--help") || args.includes("-h")) { console.log(agentsHelp); return; }
  if (!args.length && process.stdin.isTTY && process.stdout.isTTY) {
    const { runAgentsPage } = await import("./agents-page.js");
    await runAgentsPage({ launch }); return;
  }
  const client = await managementClient(launch);
  try {
    const snapshot = await client.request("snapshot");
    const team = value => selectRecord(snapshot.teams, value, "Team");
    const agent = (value, teamId) => selectRecord(snapshot.agents.filter(a => !teamId || snapshot.memberships.some(m => m.teamId === teamId && m.agentId === a.id)), value, "Agent");
    let result;
    const [command, sub, ...rest] = args;
    if (!command || command === "list") { result = snapshot; if (!json) { console.log(overviewText(snapshot)); return; } }
    else if (command === "manager") { await openAgentChat({ manager: true, launch }); return; }
    else if (command === "open") {
      const [teamValue, agentValue] = (sub || "").split("/");
      const selectedTeam = team(teamValue);
      await openAgentChat({ agent: agent(agentValue, selectedTeam.id), teamId: selectedTeam.id, launch }); return;
    } else if (command === "team") {
      if (sub === "create") result = await client.request("createTeam", { name: rest.slice(0, rest.includes("--root") ? rest.indexOf("--root") : rest.length).join(" "), createRoot: option(rest, "--root") });
      else {
        const selected = team(rest[0]);
        if (sub === "add") {
          result = await client.request("addMember", { teamId: selected.id, workspace: rest[1], share: rest.includes("--share"), position: option(rest, "--position"), responsibility: option(rest, "--responsibility") });
          if (!selected.leaderAgentId) await client.request("setLeader", { teamId: selected.id, agentId: result.agentId });
        }
        else if (sub === "leader" || sub === "remove") result = await client.request(sub === "leader" ? "setLeader" : "removeMember", { teamId: selected.id, agentId: agent(rest[1], selected.id).id });
        else if (sub === "workspace") result = await client.request("createWorkspace", { teamId: selected.id, name: rest[1] });
        else if (sub === "worktree") result = await client.request("createWorktree", { teamId: selected.id, name: rest[1], repository: rest[2], branch: rest[3], base: rest[4] });
        else if (sub === "copy") {
          const preview = await client.request("previewCopy", { source: rest[2] });
          const confirmation = option(rest, "--confirm");
          result = confirmation ? await client.request("copyWorkspace", { teamId: selected.id, name: rest[1], source: rest[2], confirmation }) : preview;
        } else throw new Error(agentsHelp);
      }
    } else if (command === "task") {
      const selected = team(sub);
      result = await client.request("assignTask", { teamId: selected.id, assigneeAgentId: agent(rest[0], selected.id).id, brief: rest.slice(1).join(" ") });
    } else if (["show", "start", "note"].includes(command)) {
      const task = selectRecord(snapshot.tasks, sub, "Task");
      result = await client.request({ show: "getTask", start: "startTask", note: "postTaskNote" }[command], { taskId: task.id, ...(command === "note" ? { text: rest.filter(s => s !== "--answer").join(" "), answer: rest.includes("--answer") } : {}) });
    } else if (command === "stop") result = await client.request("cancelRun", { runId: sub });
    else if (command === "resolve") result = await client.request("resolveRun", { runId: sub, confirmStopped: rest.includes("--confirm-stopped") });
    else if (command === "artifact") result = await client.request("readArtifact", { artifactId: sub });
    else if (command === "import") {
      const { importLegacyTeam } = await import("./agents-import.js");
      result = await importLegacyTeam({ client, root: sub, confirm: rest.includes("--confirm"), share: rest.includes("--share"), launch });
    } else throw new Error(agentsHelp);
    console.log(JSON.stringify(result, null, 2));
  } finally { client.close(); }
}
function option(args, flag) { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; }
