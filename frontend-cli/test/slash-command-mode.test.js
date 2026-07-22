import assert from "node:assert/strict";
import test from "node:test";

import { isReadonlySlashCommand, steeringCommandText } from "../lib/slash-command-mode.js";

test("readonly slash commands keep the prompt responsive", () => {
  assert.equal(isReadonlySlashCommand("/status"), true);
  assert.equal(isReadonlySlashCommand(" /status "), true);
  assert.equal(isReadonlySlashCommand("/status bad"), true);
  assert.equal(isReadonlySlashCommand("/doctor"), true);
  assert.equal(isReadonlySlashCommand("/doctor extra"), true);
});

test("mutating and interactive slash commands stay blocking", () => {
  assert.equal(isReadonlySlashCommand("/compact"), false);
  assert.equal(isReadonlySlashCommand("/model"), false);
  assert.equal(isReadonlySlashCommand("/help"), false);
  assert.equal(isReadonlySlashCommand("hello"), false);
});

test("steer commands extract only their direction text", () => {
  assert.equal(steeringCommandText("/steer focus on tests"), "focus on tests");
  assert.equal(steeringCommandText(" /STEER   use the API\nfirst "), "use the API\nfirst");
  assert.equal(steeringCommandText("/steer"), "");
  assert.equal(steeringCommandText("/steering elsewhere"), null);
  assert.equal(steeringCommandText("hello"), null);
});
