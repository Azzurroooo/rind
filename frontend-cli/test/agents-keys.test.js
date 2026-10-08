import assert from "node:assert/strict";
import test from "node:test";

import { ACTIONS, actionFor, available, helpGroups, hintsFor } from "../lib/agents-keys.js";

const keyOf = spec => spec === "enter" ? { name: "enter" } : spec === "space" ? { text: " " } : spec === "tab" ? { name: "tab" } : { text: spec };
const main = (page, extra = {}) => ({ focus: "main", page, ...extra });

const CASES = [
  ["sidebar team", { focus: "sidebar", page: { kind: "inbox" } }, { kind: "team" }],
  ["member row", main({ kind: "team", teamId: "t", tab: "org" }), { kind: "member", agentId: "a", teamId: "t" }],
  ["conversation row", main({ kind: "team", teamId: "t", tab: "org" }), { kind: "session", sessionId: "s" }],
  ["add-member row", main({ kind: "team", teamId: "t", tab: "org" }), { kind: "add-member" }],
  ["task row", main({ kind: "team", teamId: "t", tab: "tasks" }), { kind: "task", taskId: "x", status: "Done" }],
  ["assign row", main({ kind: "team", teamId: "t", tab: "tasks" }), { kind: "assign" }],
  ["member page", main({ kind: "member", teamId: "t", agentId: "a" }), { kind: "session", sessionId: "s" }],
  ["folder", main({ kind: "folder", workspace: "/w" }), { kind: "session", sessionId: "s", workspace: "/w" }],
  ["inbox answer", main({ kind: "inbox" }), { kind: "task", taskId: "x", answer: true }],
  ["background service", main({ kind: "background" }), { kind: "service" }],
];

test("every footer hint is a key that runs exactly that action", () => {
  for (const [name, view, row] of CASES) {
    for (const action of available(view, row)) {
      const found = actionFor(view, row, keyOf(ACTIONS[action.id].keys[0]));
      assert.equal(found?.id, action.id, name + ": " + action.id);
    }
    const shown = hintsFor(view, row).map(hint => hint.key);
    for (const action of available(view, row).filter(a => !["help", "foldAll"].includes(a.id))) assert.ok(shown.includes(ACTIONS[action.id].key), name + " shows " + action.id);
  }
});

test("keys a row does not offer do nothing", () => {
  const tasks = main({ kind: "team", teamId: "t", tab: "tasks" });
  assert.equal(actionFor(tasks, { kind: "task", taskId: "x" }, { text: "c" }), undefined, "no conversation on the Tasks tab");
  assert.equal(actionFor(tasks, { kind: "assign" }, { text: " " }), undefined, "space never falls back to enter");
  assert.equal(actionFor(main({ kind: "inbox" }), { kind: "task" }, { text: "n" }), undefined, "new team lives on the sidebar and team pages");
  assert.equal(actionFor(main({ kind: "team", teamId: "t", tab: "org" }), { kind: "session" }, { text: "e" }), undefined, "edit only on members");
  assert.equal(actionFor(main({ kind: "inbox" }), { kind: "task", answer: true }, { text: " " }), undefined);
});

test("labels say what happens to the selected row", () => {
  const org = main({ kind: "team", teamId: "t", tab: "org" });
  const label = (view, row, id) => available(view, row).find(a => a.id === id)?.label;
  assert.equal(label(org, { kind: "member" }, "open"), "open member");
  assert.equal(label(org, { kind: "member" }, "add"), "add member below");
  assert.equal(label(org, { kind: "add-member" }, "add"), "add member");
  assert.equal(label(main({ kind: "team", tab: "tasks" }), { kind: "task", status: "Done" }, "open"), "open report");
  assert.equal(label({ focus: "sidebar", page: { kind: "inbox" } }, { kind: "team" }, "open"), "open");
});

test("help is built from the same table and never mentions direct reports", () => {
  const text = JSON.stringify(helpGroups());
  for (const action of Object.values(ACTIONS)) assert.ok(text.includes(action.help), action.help);
  assert.doesNotMatch(text, /direct report/);
});

test("fold is offered only where something can fold", () => {
  const org = main({ kind: "team", teamId: "t", tab: "org" });
  const offers = (view, row) => available(view, row).some(action => action.id === "fold");
  assert.equal(offers(org, { kind: "add-member" }), false, "the add row has no branch");
  assert.equal(offers(org, { kind: "member", agentId: "a", expandable: false }), false, "a member with nothing below");
  assert.equal(offers(org, { kind: "member", agentId: "a", expandable: true }), true);
  assert.equal(offers(org, { kind: "session", sessionId: "s" }), true, "folds the member it sits under");
  const independent = main({ kind: "independent" });
  assert.equal(offers(independent, { kind: "workspace", workspace: "/w" }), true);
  assert.equal(offers(independent, { kind: "session", sessionId: "s", workspace: "/w" }), true);
  // Fold all stays: it acts on the whole list, not the selected row.
  assert.ok(available(org, { kind: "add-member" }).some(action => action.id === "foldAll"));
});
