import test from "node:test";
import assert from "node:assert/strict";

import { executeLocalSlashCommand } from "../lib/local-slash-commands.js";
import { resetMaxConcurrentRuns, resetSpinner, setBriefMode } from "../lib/cli-state-store.js";

test("local status renders session and provider state", async () => {
  const result = await executeLocalSlashCommand("/status", {
    sessionInfo: {
      session_id: "session_1",
      provider: "openai",
      model: "gpt-5.5",
      reasoning_effort: "high",
      providers: [
        { id: "openai", configured: true, source: "stored" },
        { id: "deepseek", configured: false, source: "none" },
      ],
    },
    runtimeInitialized: false,
    runtimeStarted: false,
  });

  assert.deepEqual(result.display, {
    type: "status",
    entries: [
      { label: "session", value: "session_1" },
      { label: "name", value: "unset · shown by its first message" },
      { label: "connection", value: "openai" },
      { label: "model", value: "gpt-5.5" },
      { label: "reasoningEffort", value: "high" },
      { label: "configured", value: "openai" },
    ],
    usage: [],
  });
});

test("config, brief, import, and theme are no longer standalone local slash commands", async () => {
  assert.equal(await executeLocalSlashCommand("/config", {}), null);
  assert.equal(await executeLocalSlashCommand("/brief", {}), null);
  assert.equal(await executeLocalSlashCommand("/import", {}), null);
  assert.equal(await executeLocalSlashCommand("/theme", {}), null);
});

test("/settings brief reads and updates global brief output mode", async (t) => {
  t.after(() => setBriefMode(false));
  setBriefMode(false);
  const initial = await executeLocalSlashCommand("/settings brief", {});
  assert.deepEqual(initial, {
    text: "Brief output: off",
    display: { type: "brief", changed: false, enabled: false },
  });

  let persisted = null;
  const enabled = await executeLocalSlashCommand("/settings brief on", {
    persistBrief: (val) => { persisted = val; },
  });
  assert.equal(persisted, true);
  assert.deepEqual(enabled, {
    text: "Brief output: on",
    display: { type: "brief", changed: true, enabled: true },
  });

  const invalid = await executeLocalSlashCommand("/settings unknown", {});
  assert.match(invalid.text, /^Usage: \/settings/);
});

test("/settings spinner lists the four animations and updates the active working spinner", async (t) => {
  t.after(() => resetSpinner());
  resetSpinner();
  const listed = await executeLocalSlashCommand("/settings spinner", {});
  assert.equal(listed.display.type, "spinner");
  assert.equal(listed.display.changed, false);
  assert.equal(listed.display.current, "orbit");
  assert.deepEqual(listed.display.spinners.map((item) => item.name), [
    "sweep",
    "pulse",
    "bars",
    "orbit",
  ]);

  let persisted = null;
  const switched = await executeLocalSlashCommand("/settings spinner pulse", {
    persistSpinner: (name) => { persisted = name; },
  });
  assert.equal(persisted, "pulse");
  assert.equal(switched.display.changed, true);
  assert.equal(switched.display.previous, "orbit");
  assert.equal(switched.display.current, "pulse");

  const byNumber = await executeLocalSlashCommand("/settings spinner 1", {});
  assert.equal(byNumber.display.current, "sweep");

  const unknown = await executeLocalSlashCommand("/settings spinner sparkle", {});
  assert.match(unknown.text, /Unknown spinner/);
});

test("/settings concurrency reads and updates global max concurrent runs across preset tiers", async (t) => {
  t.after(() => resetMaxConcurrentRuns());
  resetMaxConcurrentRuns();
  const initial = await executeLocalSlashCommand("/settings concurrency", {});
  assert.deepEqual(initial, {
    text: "Max concurrent runs: 128",
    display: { type: "concurrency", changed: false, current: 128 },
  });

  let persisted = null;
  const updated = await executeLocalSlashCommand("/settings concurrency 256", {
    persistMaxConcurrentRuns: async (val) => { persisted = val; },
  });
  assert.equal(persisted, 256);
  assert.deepEqual(updated, {
    text: "Max concurrent runs: 256",
    display: { type: "concurrency", changed: true, previous: 128, current: 256 },
  });

  const invalid = await executeLocalSlashCommand("/settings concurrency 100", {});
  assert.match(invalid.text, /Invalid concurrency limit "100"\. Available: 4, 8, 16, 32, 64, 128, 256, 512\./);
});

test("local status before the first message shows the pending name", async () => {
  const result = await executeLocalSlashCommand("/status", { sessionInfo: {}, pendingName: "Spike", runtimeInitialized: false });
  const entries = Object.fromEntries(result.display.entries.map(entry => [entry.label, entry.value]));
  assert.equal(entries.session, "none · the first message starts it");
  assert.equal(entries.name, "Spike · applies when the conversation starts");
});
