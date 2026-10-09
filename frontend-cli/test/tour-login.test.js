import test from "node:test";
import assert from "node:assert/strict";
import { findTourPage } from "../lib/tour/pages/index.js";
import { createTourStage } from "../lib/tour/stage.js";
import { renderTourPage } from "../lib/tour/render.js";
import { parseConfigArgs } from "../lib/config-command.js";
import { stripAnsi } from "../lib/text-width.js";

test("account lesson selects OAuth, explains callback and does not simulate API-key entry", () => {
  const page = findTourPage("login.account");
  const method = page.steps.find(step => step.kind === "menu").menu;
  assert.equal(method.options[method.target ?? method.selected], "Sign in with an account");
  assert.ok(page.steps.some(step => step.kind === "type" && step.text === "/login openai"));
  assert.ok(!page.steps.some(step => step.menu?.kind === "auth-secret"));
  const text = JSON.stringify(page);
  assert.match(text, /without an API key/);
  assert.match(text, /callback finishes login automatically/);
  assert.match(text, /Eligibility and limits depend on your plan/);
  assert.match(text, /simulation opens no browser/);
});

test("named endpoint teaches the real ordered fields with readable text and masked key", () => {
  const page = findTourPage("login.endpoint");
  const fields = page.steps.filter(step => ["auth-input", "auth-secret"].includes(step.menu?.kind));
  assert.deepEqual(fields.map(step => step.menu.title), ["Connection name",
    "Base URL (OpenAI-compatible, e.g. https://host/v1)",
    "Model id (empty: use the endpoint model list)", "Demo endpoint API key"]);
  for (const [index, step] of page.steps.entries()) {
    if (!fields.includes(step)) continue;
    const stage = createTourStage(); stage.rebuildTo(page.steps, index);
    const state = { page, pageIndex: 0, pageCount: 20, stepIndex: index,
      stepCount: page.steps.length, phase: "waiting", speed: 1 };
    const text = renderTourPage(stage.snapshot(), state, 100, 30).lines.map(stripAnsi).join("\n");
    if (step.menu.kind === "auth-secret") {
      assert.doesNotMatch(text, /demo-key-only/);
      assert.match(text, /•{13}/);
    } else assert.ok(text.includes(step.menu.value), step.menu.title);
  }
  assert.match(JSON.stringify(page), /logout demo-endpoint removes this named connection/);
});

test("text login prompts animate, settle and replay just like masked prompts", () => {
  const stage = createTourStage();
  const step = { kind: "menu", menu: { kind: "auth-input", title: "Connection name", value: "Demo 中文" } };
  stage.beginStep(step);
  assert.equal(stage.snapshot().rind.composer.menu.value, "");
  stage.tick();
  assert.equal(stage.snapshot().rind.composer.menu.value, "D");
  while (stage.tick());
  stage.settleStep(step);
  const replay = createTourStage(); replay.rebuildTo([step], 0);
  assert.deepEqual(stage.snapshot(), replay.snapshot());
});

test("folder defaults teach valid CLI commands and separate user storage from project files", () => {
  const page = findTourPage("config.folder");
  const commands = page.steps.filter(step => step.kind === "shell").map(step => parseConfigArgs(step.command.split(" ").slice(2)));
  assert.deepEqual(commands.map(command => [command.action, command.group]), [
    ["set", "model"], ["set", "reasoning_effort"], ["unset", "model"], ["unset", "reasoning_effort"],
  ]);
  assert.equal(commands[0].connection, "zai");
  assert.equal(commands[0].folder, process.cwd());
  assert.match(JSON.stringify(page), /RIND_HOME\/workspaces\.json/);
  assert.doesNotMatch(JSON.stringify(page), /\.rind\/settings\.json/);
  assert.match(JSON.stringify(page), /existing sessions keep their saved selection/);
});
