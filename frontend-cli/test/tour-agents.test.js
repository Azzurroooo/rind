import test from "node:test";
import assert from "node:assert/strict";
import { agentsScene } from "../lib/tour/pages/agents-demo.js";
import { agents } from "../lib/tour/pages/steps.js";
import { findTourPage } from "../lib/tour/pages/index.js";
import { createTourStage } from "../lib/tour/stage.js";
import { renderTourAgents } from "../lib/tour/agents-view.js";
import { renderTourPage } from "../lib/tour/render.js";
import { renderAgents } from "../lib/agents-view.js";
import { organizationRows, sidebarRows, teamSessions } from "../lib/agents-model.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

test("management scenes stay serializable and rendering does not mutate their replay data", () => {
  for (const pageId of ["agents.create", "agents.tasks", "agents.sessions"]) {
    for (const step of findTourPage(pageId).steps.filter(step => step.kind === "agents")) {
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
