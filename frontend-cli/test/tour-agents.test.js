import test from "node:test";
import assert from "node:assert/strict";
import { agentsScene, agentsSetupScene } from "../lib/tour/pages/agents-demo.js";
import { agents } from "../lib/tour/pages/steps.js";
import { findTourPage, tourPages } from "../lib/tour/pages/index.js";
import { createActions } from "../lib/agents-actions.js";
import { createTourStage } from "../lib/tour/stage.js";
import { renderTourAgents } from "../lib/tour/agents-view.js";
import { renderTourPage } from "../lib/tour/render.js";
import { renderAgents } from "../lib/agents-view.js";
import { organizationRows, sidebarRows, teamSessions } from "../lib/agents-model.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

test("management scenes stay serializable and rendering does not mutate their replay data", () => {
  for (const page of tourPages().filter(page => page.id.startsWith("agents."))) {
    for (const step of page.steps.filter(step => step.kind === "agents" && step.screen)) {
      const before = structuredClone(step.screen);
      assert.deepEqual(JSON.parse(JSON.stringify(before)), before);
      for (const [width, rows] of [[36, 14], [40, 16], [76, 18], [116, 30]]) {
        const first = renderTourAgents(step.screen, width, rows);
        assert.deepEqual(renderTourAgents(step.screen, width, rows), first);
        assert.ok(first.length < rows && first.every(line => textWidth(line) <= width));
        assert.deepEqual(step.screen, before);
      }
    }
  }
});

test("tour organization uses the live Agents renderer and row projections", () => {
  const scene = agentsScene();
  const view = { ...scene, navId: "product", sidebar: sidebarRows(scene.snapshot),
    entries: [{ id: "add-member", kind: "add-member", title: "Add member", teamId: "product" },
      ...organizationRows(scene.snapshot, "product", teamSessions(scene.snapshot, "product"), { now: scene.now })],
    pageKey: "team:product:org", scroll: {}, query: "", filter: "All", connection: "connected", returnTo: { own: true } };
  assert.deepEqual(renderTourAgents(scene, 116, 30), renderAgents(view, 116, 30, scene.now));
});

test("managed parent waits for its linked child and resumes in the same session", () => {
  const waiting = agentsScene("delegated").snapshot;
  const resumed = agentsScene("resumed").snapshot;
  const parent = waiting.tasks.find(task => task.id === "parser");
  const child = waiting.tasks.find(task => task.id === "review");
  assert.equal(parent.status, "blocked");
  assert.equal(parent.blockedOn.responder, "children");
  assert.equal(child.parentTaskId, parent.id);
  assert.equal(child.status, "running");
  assert.equal(resumed.tasks.find(task => task.id === child.id).status, "done");
  assert.ok(resumed.tasks.find(task => task.id === child.id).report.evidence.length);
  assert.equal(resumed.tasks.find(task => task.id === parent.id).status, "running");
  assert.equal(resumed.sessions.find(session => session.taskId === parent.id).runtimeSessionId,
    waiting.sessions.find(session => session.taskId === parent.id).runtimeSessionId);
});

test("direct chat only creates the assigned specialist task, not an implicit parent", () => {
  const { snapshot } = agentsScene("direct");
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].assigneeAgentId, "reviewer");
  assert.equal(snapshot.tasks[0].parentTaskId, undefined);
  assert.equal(snapshot.sessions[0].origin, "direct");
  assert.equal(snapshot.sessions[0].taskId, undefined);
  assert.equal(snapshot.runs.length, 0);
});

test("management overlays retain chat input and clear on close, rewind or reset", () => {
  const steps = [{ kind: "startup", info: { session_id: "s1" } },
    { kind: "type", text: "Keep this 中文 draft" }, agents(agentsScene("assign")), agents(null)];
  const stage = createTourStage();
  stage.rebuildTo(steps, 2);
  const snapshot = stage.snapshot();
  snapshot.agents.snapshot.teams[0].name = "Do not mutate the stage";
  assert.equal(stage.snapshot().agents.snapshot.teams[0].name, "product");
  assert.equal(stage.snapshot().rind.composer.text, "Keep this 中文 draft");
  stage.rebuildTo(steps, 3);
  assert.equal(stage.snapshot().agents, null);
  assert.equal(stage.snapshot().rind.composer.text, "Keep this 中文 draft");
  stage.rebuildTo(steps, 1);
  assert.equal(stage.snapshot().agents, null);
  stage.reset();
  assert.equal(stage.snapshot().agents, null);
});

test("the tour shows the real task form, report and scrolled evidence without a chat composer", () => {
  const page = findTourPage("agents.tasks");
  for (const [index, step] of page.steps.entries()) {
    if (step.kind !== "agents") continue;
    const stage = createTourStage(); stage.rebuildTo(page.steps, index);
    const state = { page, pageIndex: 0, pageCount: 20, stepIndex: index,
      stepCount: page.steps.length, phase: "waiting", speed: 1 };
    const rendered = renderTourPage(stage.snapshot(), state, 80, 24);
    const text = rendered.lines.map(stripAnsi).join("\n");
    assert.equal(rendered.cursor, null);
    assert.doesNotMatch(text, /Ask Rind to do anything|Rind v/);
    if (step.screen.dialog) assert.match(text, /Assign task[\s\S]*Task and expected delivery/);
    if (step.screen.reportTaskId && !step.screen.reportOffset) assert.match(text, /Summary[\s\S]*Unicode review complete/);
    if (step.screen.reportOffset) assert.match(text, /Evidence[\s\S]*4 parser tests passed \(simulated\)[\s\S]*unicode\.md/);
  }
});

test("interactive setup menus and fields match the real Agents actions", async () => {
  let form, choice;
  const ui = {
    view: { snapshot: agentsSetupScene("first-member-menu").snapshot },
    form(title, fields, submit, options = {}) { form = { title, fields, submit, ...options }; },
    choose(title, items, options = {}) { choice = { title, items, ...options }; },
    async request() { throw Object.assign(new Error("Simulated sharing decision"), {
      code: "WORKSPACE_SHARED", details: { teams: ["operations"] },
    }); },
  };
  const actions = createActions(ui);
  const fields = values => values.map(field => ({ key: field.key, label: field.label,
    kind: field.kind || "text", optional: Boolean(field.optional), hint: field.hint, require: field.require || "" }));
  const menu = items => items.map(({ label, description }) => ({ label, description }));
  const sameForm = phase => {
    const dialog = agentsSetupScene(phase).dialog;
    assert.equal(dialog.title, form.title);
    assert.deepEqual(fields(dialog.fields), fields(form.fields));
    assert.deepEqual(dialog.description || [], form.description || []);
  };
  actions.createTeam();
  sameForm("new-team");
  actions.addMember("product");
  assert.deepEqual(menu(agentsSetupScene("first-member-menu").dialog.items), menu(choice.items));
  choice.items[0].action();
  sameForm("first-member-folder");
  ui.view.snapshot = agentsScene("created").snapshot;
  actions.addMember("product", "demo");
  assert.deepEqual(menu(agentsSetupScene("add-menu").dialog.items), menu(choice.items));
  choice.items[0].action();
  sameForm("specialist-folder");
  await form.submit({ workspace: "~/finance", name: "finance", position: "Finance", responsibility: "Reconcile invoices" });
  const sharing = agentsSetupScene("share-folder").dialog;
  assert.equal(choice.title, sharing.title);
  assert.deepEqual(menu(choice.items), menu(sharing.items));
  assert.deepEqual(choice.description, sharing.description);
  actions.addMember("product", "demo");
  choice.items[2].action();
  sameForm("worktree-repository");
});

test("setup forms show the focused field and preserve honest navigation and conversation states", () => {
  for (const page of tourPages().filter(page => page.id.startsWith("agents."))) {
    for (const [index, step] of page.steps.entries()) {
      if (!step.screen) continue;
      const stage = createTourStage(); stage.rebuildTo(page.steps, index);
      const state = { page, pageIndex: 0, pageCount: 20, stepIndex: index,
        stepCount: page.steps.length, phase: "waiting", speed: 1 };
      const rendered = renderTourPage(stage.snapshot(), state, 80, 24);
      const text = rendered.lines.map(stripAnsi).join("\n");
      const dialog = step.screen.dialog;
      if (dialog?.fields) {
        const active = dialog.fields[dialog.index ?? 0];
        assert.ok(text.includes("› " + active.label), `${page.id} step ${index}: focused field`);
        assert.ok(text.includes(active.value), `${page.id} step ${index}: entered value`);
      }
      if (dialog?.kind === "choice") {
        assert.ok(text.includes(dialog.items[dialog.index].label));
        assert.match(text, /enter confirm/);
      }
      assert.doesNotMatch(text, /rind agents/);
      assert.equal(rendered.cursor, null);
    }
  }
  const empty = agentsSetupScene("empty-navigation");
  assert.equal(empty.snapshot.teams.length, 0);
  const first = agentsSetupScene("first-member-menu");
  assert.equal(first.snapshot.teams.length, 1);
  assert.equal(first.snapshot.memberships.length, 0);
  assert.equal(first.snapshot.teams[0].leaderAgentId, undefined);
  const member = agentsSetupScene("leader-sessions");
  assert.equal(member.page.kind, "member");
  assert.equal(member.snapshot.tasks.length, 0);
  const worktrees = agentsSetupScene("worktrees").snapshot.agents;
  assert.equal(new Set(worktrees.map(agent => agent.canonicalWorkspace)).size, 3);
});
