import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { executeLocalSlashCommand } from "../lib/local-slash-commands.js";

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
      { label: "provider", value: "openai" },
      { label: "model", value: "gpt-5.5" },
      { label: "reasoningEffort", value: "high" },
      { label: "configured", value: "openai" },
    ],
    usage: [],
  });
});

test("config is no longer a local slash command", async () => {
  assert.equal(await executeLocalSlashCommand("/config", {}), null);
});
