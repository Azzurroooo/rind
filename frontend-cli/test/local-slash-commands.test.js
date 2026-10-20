import test from "node:test";
import assert from "node:assert/strict";

import { executeLocalSlashCommand } from "../lib/local-slash-commands.js";
import { setBriefMode } from "../lib/cli-state-store.js";

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

test("config, brief, and import are no longer standalone local slash commands", async () => {
  assert.equal(await executeLocalSlashCommand("/config", {}), null);
  assert.equal(await executeLocalSlashCommand("/brief", {}), null);
  assert.equal(await executeLocalSlashCommand("/import", {}), null);
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

test("local status before the first message shows the pending name", async () => {
  const result = await executeLocalSlashCommand("/status", { sessionInfo: {}, pendingName: "Spike", runtimeInitialized: false });
  const entries = Object.fromEntries(result.display.entries.map(entry => [entry.label, entry.value]));
  assert.equal(entries.session, "none · the first message starts it");
  assert.equal(entries.name, "Spike · applies when the conversation starts");
});
