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
      if (method === "getMemberModel") return { folder,
        resolved: { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "low", model_source: folder.model ? "folder" : "settings", effort_source: effortSource },
        inherited: { provider: "openai", model: "gpt-5.5", reasoning_effort: "high", model_source: "main_repository", effort_source: "settings" } };
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
  const models = dialogs[2];
  assert.equal(models.options.selected, "deepseek/deepseek-flash");
  assert.equal(models.options.searchable, true);
  assert.deepEqual(models.items.map(entry => (entry.header ? "# " : "") + entry.label), ["# deepseek", "deepseek-flash", "# openai", "gpt-5.5"], "grouped by connection, as /model is");
  assert.equal(item(models, "deepseek-flash").description, "current");
  assert.ok(!models.items.some(entry => entry.label === "Use the default"), "nothing to clear when the member has no own model");
  await item(models, "gpt-5.5").action();
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
  item(dialogs[1], "Model").action();
  assert.equal(dialogs[2].items[0].label, "Use the default", "first, and says what it falls back to");
  assert.equal(dialogs[2].items[0].description, "openai / gpt-5.5 · from its main repository");
  item(dialogs[1], "Effort").action();
  assert.equal(dialogs[3].items[0].description, "high · from settings.json");
  await item(dialogs[3], "Use the default").action();
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

test("a selected conversation says what it runs on and warns when its connection cannot run", () => {
  const s = snapshot();
  const view = { snapshot: s, page: { kind: "team" },
    history: { team: { entries: [{ runtimeSessionId: "r1", agentId: "lead", teamId: "team", title: "Plan", provider: "deepseek", model: "deepseek-flash", reasoningEffort: "high", selectionSource: { model: "folder", effort: "session" }, connectionReady: true }] } },
    independent: { workspaces: [{ workspace: "/w/free", sessions: [{ runtimeSessionId: "r2", title: "Free", provider: "gone", model: "m", connectionReady: false }] }] } };
  const text = row => detailFor(view, row).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  const team = text({ kind: "session", sessionId: "r1", agentId: "lead", teamId: "team", title: "Plan", status: "Idle" });
  assert.match(team, /deepseek \/ deepseek-flash · high/);
  assert.match(team, /model folder default · effort this conversation/);
  assert.doesNotMatch(team, /not configured/);
  const free = text({ kind: "session", independent: true, sessionId: "r2", title: "Free", workspace: "/w/free", status: "Idle" });
  assert.match(free, /gone \/ m\n/);
  assert.match(free, /! gone is not configured · its next turn fails/);
  s.live = [{ id: "r1", provider: "openai", model: "gpt-5.5", reasoningEffort: "", selectionSource: { model: "session" }, connectionReady: true }];
  assert.match(text({ kind: "session", sessionId: "r1", agentId: "lead", teamId: "team", title: "Plan", status: "Open" }), /openai \/ gpt-5\.5\n.*model this conversation/, "a change in some window shows at once");
});

test("a member or folder says what new conversations there start with, always the value in effect", () => {
  const s = snapshot();
  const view = { snapshot: s, page: { kind: "team" }, folderDefaults: {
    "/w/lead": { provider: "deepseek", model: "deepseek-flash", reasoning_effort: "", model_source: "main_repository", effort_source: "settings", connection_ready: false },
    "/w/free": { provider: "openai", model: "gpt-5.5", reasoning_effort: "high", model_source: "settings", effort_source: "folder", connection_ready: true } } };
  const text = row => detailFor(view, row).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  const member = text({ kind: "member", teamId: "team", agentId: "lead", title: "Lead", status: "Idle", leader: true });
  assert.match(member, /Runs on · Space › Model and effort\ndeepseek \/ deepseek-flash · main repository\neffort unset · settings\.json/);
  assert.match(member, /! deepseek is not configured · new conversations fail/);
  const folder = text({ kind: "workspace", title: "free", workspace: "/w/free", teams: [], sessionCount: 1 });
  assert.match(folder, /New conversations start with\nopenai \/ gpt-5\.5 · settings\.json\neffort high · this folder/);
  assert.doesNotMatch(text({ kind: "workspace", title: "x", workspace: "/w/unknown", teams: [], sessionCount: 0 }), /start with/, "nothing until loaded");
});
