import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentsPage } from "../lib/agents-page.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { harness } from "./helpers/agents-harness.js";

function openPage(t, h, options = {}) {
  const abort = new AbortController();
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, openChat: async () => {}, ...options });
  t.after(async () => { abort.abort(); await running; await h.cleanup(); });
}

test("a team is deleted from the sidebar by typing its name, and its tasks are removed", { timeout: 40000 }, async t => {
  const h = await harness({ prefix: "rind-agents-delete-" });
  const team = await h.client.request("createTeam", { name: "Product" });
  const lead = await h.client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  await h.client.request("assignTask", { teamId: team.id, assigneeAgentId: lead.id, brief: "Write the launch notes", start: false });
  openPage(t, h);
  const { key, paste, visible } = h;

  await visible("Product");
  key("j"); key("j"); key("j"); key("j"); await visible("space more actions");
  key(" "); await visible("Delete team…"); key("x");
  await visible("Delete Product?");
  await visible("1 member is released and 1 task is removed.");
  await visible("Folders, their files and conversation history are never touched.");
  paste("product"); key("\r"); await visible("Type Product exactly to delete it.");
  key("\x15"); paste("Product"); key("\r");
  await visible("Product deleted.");
  const snapshot = await h.client.request("snapshot");
  assert.deepEqual(snapshot.teams, []);
  assert.deepEqual(snapshot.tasks, []);
  assert.doesNotMatch(h.screen(), /Archive|Write the launch notes/);
});

test("the Manager's request to delete a team waits in the Inbox until the user decides", { timeout: 40000 }, async t => {
  const h = await harness({ prefix: "rind-agents-approval-" });
  const team = await h.client.request("createTeam", { name: "Research" });
  const lead = await h.client.request("createWorkspace", { teamId: team.id, name: "Lead" });
  await h.client.request("assignTask", { teamId: team.id, assigneeAgentId: lead.id, brief: "Survey papers", start: false });
  const manager = await h.client.request("attachSession", { manager: true, runtimeSessionId: "manager-chat" });
  openPage(t, h);
  const { key, visible } = h;

  await visible("Nothing needs you right now");
  // The Manager speaks with the token its conversation is given; asking only creates an approval.
  const tools = await h.client.request("sessionTools", { sessionId: manager.id });
  const asManager = await connectClient({ endpoint: tools.env.RIND_MANAGEMENT_ENDPOINT, token: tools.env.RIND_MANAGEMENT_TOKEN, runtimeSessionId: "manager-chat" });
  t.after(() => asManager.close());
  assert.equal((await asManager.request("deleteTeam", { teamId: team.id })).approval.kind, "deleteTeam");
  await visible("Approve: Delete team Research");
  key("\r"); await visible("enter decide");
  key("\r"); await visible("The Manager asks to delete Research.");
  key("n"); await visible("Declined.");
  assert.equal((await h.client.request("snapshot")).teams.length, 1);
});

test("CLI team organization view loads and refreshes multi-member conversations without lock errors during active session_index.json contention and stale locks", { timeout: 60000 }, async t => {
  const h = await harness({ prefix: "rind-agents-index-lock-" });
  const team = await h.client.request("createTeam", { name: "SectorResearch" });
  const lead = await h.client.request("createWorkspace", { teamId: team.id, name: "ind_res_lead", role: "研究主管" });
  const coal = await h.client.request("createWorkspace", { teamId: team.id, name: "ind_res_coal", role: "行业研究员·煤炭", reportsToAgentId: lead.id });
  const steel = await h.client.request("createWorkspace", { teamId: team.id, name: "ind_res_steel", role: "行业研究员·钢铁", reportsToAgentId: lead.id });

  const runtimeEntry = new URL("../../runtime/dist/index.js", import.meta.url).href;
  const indexLockPath = path.join(h.home, "session_index.json.lock");

  // 1. Seed a stale foreign-node .lock file (simulating crashed GPU cluster node gpu10 on shared $HOME).
  await writeFile(indexLockPath, `${process.pid} gpu10-cluster-node stale-token\n`, "utf8");
  const stalePast = new Date(Date.now() - 35_000);
  await utimes(indexLockPath, stalePast, stalePast);

  // 2. Spawn concurrent runtime processes writing conversations for each team member (self-healing the stale lock).
  const seedMemberSession = (agent, promptText, replyText) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { JsonlSessionStore } from ${JSON.stringify(runtimeEntry)};
            const store = new JsonlSessionStore({
              workspaceRoot: ${JSON.stringify(agent.canonicalWorkspace)},
              model: "deepseek-flash",
              provider: "deepseek",
            });
            await store.initialize();
            await store.persistUserInput(${JSON.stringify(promptText)});
            await store.persistMessage("assistant", ${JSON.stringify(replyText)});
            process.stdout.write(store.sessionId + "\\n");
          `,
        ],
        {
          env: { ...process.env, RIND_HOME: h.home },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", d => { out += d.toString("utf8"); });
      child.stderr.on("data", d => { err += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
    });

  const [leadSessionId, coalSessionId, steelSessionId] = await Promise.all([
    seedMemberSession(lead, "Coordinate Q4 commodities outlook", "Dispatching coal and steel analysts."),
    seedMemberSession(coal, "Thermal coal inventory forecast", "Port inventories remain tight."),
    seedMemberSession(steel, "Blast furnace utilization check", "Operating rates edged higher."),
  ]);

  await h.client.request("attachSession", { teamId: team.id, agentId: lead.id, runtimeSessionId: leadSessionId });
  await h.client.request("attachSession", { teamId: team.id, agentId: coal.id, runtimeSessionId: coalSessionId });
  await h.client.request("attachSession", { teamId: team.id, agentId: steel.id, runtimeSessionId: steelSessionId });

  // 3. Hold an exclusive write lock on session_index.json in a separate process while the CLI opens and refreshes!
  const lockHolder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { FileLockHandle } from ${JSON.stringify(runtimeEntry)};
        const lock = new FileLockHandle(${JSON.stringify(indexLockPath)}, 5000);
        lock.acquire();
        process.stdout.write("HELD\\n");
        process.stdin.resume();
        process.stdin.once("data", () => {
          lock.release();
          process.exit(0);
        });
      `,
    ],
    {
      env: { ...process.env, RIND_HOME: h.home },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    },
  );
  t.after(() => {
    if (lockHolder.exitCode === null) lockHolder.kill();
  });
  await new Promise((resolve, reject) => {
    let out = "";
    lockHolder.once("error", reject);
    lockHolder.stdout.on("data", d => {
      out += d.toString("utf8");
      if (out.includes("HELD")) resolve();
    });
  });

  // 4. Open the CLI Agents TUI directly on the team Organization view and refresh (`r`) while the write lock is held.
  openPage(t, h, { initialTeamId: team.id });
  const { key, visible, settle } = h;

  await visible("ind_res_coal");
  await visible("Thermal coal inventory forecast");
  await visible("Blast furnace utilization check");

  key("r");
  await settle();
  await visible("Thermal coal inventory forecast");
  assert.doesNotMatch(h.screen(), /Could not load conversations/);
  assert.doesNotMatch(h.screen(), /Failed to acquire lock/);

  lockHolder.stdin.end("done\n");
  await new Promise(resolve => lockHolder.once("close", resolve));
});

test("end-to-end CLI workflow: concurrent live team tasks, standalone `rind run` processes, and TUI navigation share RIND_HOME with zero index lock failures", { timeout: 60000 }, async t => {
  const provider = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture-fast" }] }));
      return;
    }
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = String(msgs.filter(m => m.role === "user").at(-1)?.content || "ok").slice(0, 60);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done: " + lastUser }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 16, completion_tokens: 6, total_tokens: 22 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      }, 25);
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
  });

  const h = await harness({ prefix: "rind-cli-e2e-team-" });
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await writeFile(path.join(h.home, "settings.json"), JSON.stringify({ provider: "custom-gw", model: "fixture-fast" }), "utf8");
  await writeFile(path.join(h.home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "fixture" } }), "utf8");
  await writeFile(path.join(h.home, "providers.json"), JSON.stringify({ providers: { "custom-gw": { name: "Fixture", api: "openai-chat", baseUrl } } }), "utf8");

  const scratchDir = path.join(h.home, "scratch-cli");
  await mkdir(scratchDir, { recursive: true });

  const team = await h.client.request("createTeam", { name: "ResearchTeam" });
  const coal = await h.client.request("createWorkspace", { teamId: team.id, name: "ind_res_coal", role: "煤炭研究员" });
  const steel = await h.client.request("createWorkspace", { teamId: team.id, name: "ind_res_steel", role: "钢铁研究员" });
  const macro = await h.client.request("createWorkspace", { teamId: team.id, name: "ind_res_macro", role: "宏观研究员" });

  openPage(t, h, { initialTeamId: team.id });
  const { key, visible } = h;
  await visible("ind_res_coal");

  // Launch concurrent `rind run` CLI processes in the same RIND_HOME while simultaneously starting live managed team tasks.
  const cliBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));
  const runOneShot = label =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliBin, "run", "--prompt", `Standalone check ${label}`, "--dir", scratchDir],
        {
          env: { ...process.env, RIND_HOME: h.home },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", d => { stdout += d.toString("utf8"); });
      child.stderr.on("data", d => { stderr += d.toString("utf8"); });
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) reject(new Error(`rind run ${label} exited ${code}: ${stderr}`));
        else resolve(stdout.trim());
      });
    });

  const [out1, out2] = await Promise.all([
    runOneShot("alpha"),
    runOneShot("beta"),
    h.client.request("assignTask", { teamId: team.id, assigneeAgentId: coal.id, brief: "Coal Q4 supply balance", start: true }),
    h.client.request("assignTask", { teamId: team.id, assigneeAgentId: steel.id, brief: "Steel mill margin update", start: true }),
    h.client.request("assignTask", { teamId: team.id, assigneeAgentId: macro.id, brief: "Macro credit impulse", start: true }),
    (async () => {
      // Refresh team conversations repeatedly from the CLI TUI while runs and CLI processes write concurrently.
      for (let i = 0; i < 4; i++) {
        key("r");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    })(),
  ]);

  assert.match(out1, /Done: Standalone check alpha/);
  assert.match(out2, /Done: Standalone check beta/);

  // Wait for all three team runs to finish and verify the CLI TUI shows conversations cleanly with zero lock errors.
  for (let i = 0; i < 400; i++) {
    const snap = await h.client.request("snapshot");
    if (snap.runs.length === 3 && snap.runs.every(r => !["starting", "running"].includes(r.status))) {
      break;
    }
    if (i === 399) assert.fail("Timed out waiting for all 3 team runs to finish: " + JSON.stringify(snap.runs));
    await new Promise(resolve => setTimeout(resolve, 30));
  }

  key("r");
  await visible("Coal Q4 supply balance");
  await visible("Steel mill margin update");
  await visible("Macro credit impulse");
  assert.doesNotMatch(h.screen(), /Could not load conversations/);
  assert.doesNotMatch(h.screen(), /Failed to acquire lock/);
});
