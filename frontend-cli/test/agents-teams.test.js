import test from "node:test";
import assert from "node:assert/strict";
import { runAgentsPage } from "../lib/agents-page.js";
import { connectClient } from "../../agent-management/dist/client.js";
import { harness } from "./helpers/agents-harness.js";

function openPage(t, h, options = {}) {
  const abort = new AbortController();
  const running = runAgentsPage({ launch: h.launch, input: h.input, output: h.output.output, manageInput: false, signal: abort.signal, openChat: async () => {}, ...options });
  t.after(async () => { abort.abort(); await running; await h.cleanup(); });
}

test("a team is deleted from the sidebar by typing its name, and its work stays readable in Archive", { timeout: 40000 }, async t => {
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
  await visible("1 member is released and 1 unfinished task is cancelled.");
  await visible("Folders, their files and conversation history are never touched.");
  paste("product"); key("\r"); await visible("Type Product exactly to delete it.");
  key("\x15"); paste("Product"); key("\r");
  await visible("Product deleted. Its deliveries are in Archive.");
  assert.deepEqual((await h.client.request("snapshot")).teams, []);

  await visible("Archive");
  key("G"); key("\r"); await visible("PRODUCT · DELETED");
  await visible("Write the launch notes");
  await visible("enter open report");
  key("\r"); await visible("Product was deleted. This report is kept read-only.");
  assert.doesNotMatch(h.screen(), /a accept|space more actions/, "an archived report offers no actions");
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
