// A member's model and effort on the Agents page: chosen from the member's
// Space menu, and what the Manager changed listed in the Inbox until dismissed.
import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot, inboxRows, sidebarRows } from "../lib/agents-model.js";
import { createActions } from "../lib/agents-actions.js";
import { available } from "../lib/agents-keys.js";
import { detailFor } from "../lib/agents-detail.js";

function snapshot() {
  const s = emptyAgentsSnapshot();
  s.teams.push({ id: "team", name: "Product", leaderAgentId: "lead", createRoot: "/w" });
  s.agents.push({ id: "lead", name: "Lead", canonicalWorkspace: "/w/lead" });
  s.memberships.push({ teamId: "team", agentId: "lead", status: "Idle" });
  return s;
}

function fakeUi({ folder = {}, effortSource = "settings" } = {}) {
  const requests = [], dialogs = [], notices = [];
  const ui = {
    view: { snapshot: snapshot() },
    async request(method, params) {
      requests.push([method, params]);
      if (method === "listModels") return { models: [{ provider_id: "deepseek", id: "deepseek-flash", reasoning_efforts: ["low", "high"] }, { provider_id: "openai", id: "gpt-5.5", reasoning_efforts: [] }] };
      if (method === "getMemberModel") return { folder, resolved: { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "low", model_source: folder.model ? "folder" : "settings", effort_source: effortSource } };
      return {};
    },
    choose: (title, items, options = {}) => dialogs.push({ title, items, options }),
    notify: (text, tone) => notices.push([text, tone]),
  };
  return { ui, requests, dialogs, notices };
}

const item = (dialog, label) => dialog.items.find(entry => entry.label === label);

test("the member menu sets a model and an effort for the member's next task", async () => {
  const { ui, requests, dialogs, notices } = fakeUi();
  const actions = createActions(ui);
  actions.memberActions("team", "lead");
  await item(dialogs[0], "Model and effort").action();
  const menu = dialogs[1];
  assert.match(item(menu, "Model").description, /deepseek \/ deepseek-flash · from settings\.json/);
  assert.match(menu.options.description[0], /applies from its next task; running work keeps its model/);

  item(menu, "Model").action();
  assert.equal(dialogs[2].options.selected, "deepseek/deepseek-flash");
  assert.ok(!dialogs[2].items.some(entry => entry.label === "Use the default"), "nothing to clear when the member has no own model");
  await item(dialogs[2], "openai / gpt-5.5").action();
  assert.deepEqual(requests.at(-1), ["setMemberModel", { teamId: "team", agentId: "lead", provider: "openai", model: "gpt-5.5" }]);
  assert.match(notices.at(-1)[0], /Lead now uses gpt-5\.5 from its next task/);

  item(menu, "Effort").action();
  await item(dialogs[3], "high").action();
  assert.deepEqual(requests.at(-1), ["setMemberModel", { teamId: "team", agentId: "lead", reasoningEffort: "high" }]);
});

test("an own model or effort can be cleared back to the default", async () => {
  const { ui, requests, dialogs } = fakeUi({ folder: { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "low" }, effortSource: "folder" });
  const actions = createActions(ui);
  actions.memberActions("team", "lead");
  await item(dialogs[0], "Model and effort").action();
  assert.match(item(dialogs[1], "Effort").description, /low · chosen for this member/);
  item(dialogs[1], "Effort").action();
  await item(dialogs[2], "Use the default").action();
  assert.deepEqual(requests.at(-1), ["clearMemberModel", { teamId: "team", agentId: "lead", part: "reasoningEffort" }]);
});

test("the Manager's changes wait in the Inbox, apart from what needs the user", () => {
  const s = snapshot();
  s.notices = [{ id: "n1", teamId: "team", agentId: "lead", title: "Manager set Lead's effort high", createdAt: "2026-10-06T11:00:00Z" }];
  const rows = inboxRows(s);
  const notice = rows.find(row => row.kind === "notice");
  assert.equal(rows.find(row => row.id === "section:notices").title, "Changed by the Manager");
  assert.equal(notice.title, "Manager set Lead's effort high");
  assert.match(notice.context, /^Product › Lead · /);
  assert.equal(sidebarRows(s)[0].badge, 0, "a notice is not something the user must answer");
  assert.equal(available({ focus: "main", page: { kind: "inbox" } }, notice)[0].label, "dismiss");
  assert.match(detailFor({ page: { kind: "inbox" }, snapshot: s }, notice).join("\n"), /applies from the member's next task/);
});
