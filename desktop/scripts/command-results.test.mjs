import assert from "node:assert/strict"
import test from "node:test"

import { renderCommandResult } from "../src/renderer/command-results.ts"

test("status uses the current entries/usage protocol and includes cached input", () => {
  const html = renderCommandResult({
    command: "/status", content: "fallback",
    display: { type: "status",
      entries: [{ label: "session", value: "s1" }, { label: "settings", value: "<settings>", note: "not created" }, { label: "effort", value: "high" },
        { label: "auth", value: "not signed in", note: "/login", tone: "warning" }],
      usage: [{ input_tokens: 12000, context_window_tokens: 100000, context_usage_percent: 0.12, cached_input_tokens: 9000, cache_hit_rate: 0.75, output_tokens: 345 }],
    },
  })
  for (const text of ["s1", "&lt;settings&gt;", "not created", "Reasoning effort", "high", "Sign-in", "Cached input", "75.0% hit", "12.0%", "345"]) assert.ok(html.includes(text), text)
  assert.match(html, /<div class="status-warning"><dt>Sign-in<\/dt><dd>not signed in <small>\/login<\/small>/)
  assert.ok(html.includes((9000).toLocaleString()))
  assert.match(html, /<meter[^>]*value="0.12"/)
  const empty = renderCommandResult({ command: "/status", content: "", display: { type: "status", entries: [], usage: [] } })
  assert.match(empty, /No completed sampling yet/)
  assert.doesNotMatch(empty, /<meter/)
})

test("command results render structured help as a usable command entry", () => {
  const html = renderCommandResult({
    command: "/help compact",
    content: "Compact help",
    display: {
      type: "help",
      command: { name: "compact", description: "Compact", usage: "/compact" },
      commands: [
        { name: "compact", description: "Compact", usage: "/compact" },
        { name: "model", description: "Choose a model", usage: "/model set <model>" },
      ],
    },
  })

  assert.match(html, /data-command-prefill="compact"/)
  assert.doesNotMatch(html, /data-command-prefill="model"/)
  assert.doesNotMatch(html, /\/model set &lt;model&gt;/)
})

test("structured Desktop help excludes GUI-only commands", () => {
  const html = renderCommandResult({
    command: "/help",
    content: "Commands",
    display: {
      type: "help",
      commands: [
        { name: "sessions", description: "List recent sessions", usage: "/sessions" },
        { name: "status", description: "Show status", usage: "/status" },
      ],
    },
  })

  assert.doesNotMatch(html, /data-command-prefill="sessions"/)
  assert.doesNotMatch(html, /\/sessions \[query\]/)
  assert.doesNotMatch(html, /List recent sessions/)
  assert.match(html, /data-command-prefill="status"/)
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

test("skills are grouped by layer; an import that is off stays one row", () => {
  const html = renderCommandResult({
    command: "/skill", content: "fallback",
    display: { type: "skills",
      sources: [
        { label: "Rind · project", paths: ["/work/.rind/skills"], enabled: true, importable: false, skills: [
          { name: "deploy", description: "Ship it", status: "active" },
          { name: "manual", description: "Release", status: "hidden" },
        ] },
        { label: "Claude · user", paths: ["/home/.claude/skills"], enabled: false, importable: true, skills: [{ name: "pdf", description: "Forms", status: "off" }] },
        { label: "Codex · user", paths: ["/home/.codex/skills"], enabled: true, importable: true, skills: [] },
      ],
      problems: [{ location: "/work/.rind/skills/bad/SKILL.md", message: "missing description." }],
    },
  })
  for (const text of ["Rind · project", "/work/.rind/skills", "deploy", "Ship it", "only via /skill:name", "1 skill · /import to enable", "missing description."]) assert.ok(html.includes(text), text)
  assert.ok(!html.includes("Codex · user"), "an enabled layer without skills is left out")
  assert.ok(!html.includes("Forms"), "skills of a switched-off layer are only counted")
})
