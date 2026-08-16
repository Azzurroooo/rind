import assert from "node:assert/strict"
import test from "node:test"

import { renderCommandResult } from "../src/renderer/command-results.ts"

test("command results render structured help as a usable command entry", () => {
  const html = renderCommandResult({
    command: "/help model",
    content: "Model help",
    display: {
      type: "help",
      command: { name: "model", description: "Choose a model", usage: "/model set <model>" },
      commands: [
        { name: "compact", description: "Compact", usage: "/compact" },
        { name: "model", description: "Choose a model", usage: "/model set <model>" },
      ],
    },
  })

  assert.match(html, /data-command-prefill="model"/)
  assert.doesNotMatch(html, /data-command-prefill="compact"/)
  assert.match(html, /\/model set &lt;model&gt;/)
})

test("command results escape structured display fields and keep unknown output readable", () => {
  const html = renderCommandResult({
    command: "/status",
    content: "<b>runtime text</b>",
    display: { type: "sessions", sessions: [{ id: "session-1", title: "<unsafe>", messages: 2 }] },
  })
  assert.match(html, /&lt;unsafe&gt;/)
  assert.match(html, /2 messages/)
  assert.match(html, /data-command-session-id="session-1"/)

  const fallback = renderCommandResult({ command: "/unknown", content: "<b>runtime text</b>", display: { type: "other" } })
  assert.match(fallback, /&lt;b&gt;runtime text&lt;\/b&gt;/)
})
