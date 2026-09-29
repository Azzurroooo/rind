import assert from "node:assert/strict"
import test from "node:test"

import {
  commandPrefill,
  fallbackSlashCommands,
  isExactSlashCommand,
  parseSlashCommands,
  parseSlashInput,
  revealSlashCommandOption,
  slashCommandMenu,
} from "../src/renderer/slash-commands.ts"
import { executeLocalSlashCommand } from "../src/renderer/local-slash-commands.ts"

test("Desktop hides removed and sidebar-owned commands from fallback and Runtime catalogs", () => {
  assert.equal(fallbackSlashCommands.some((command) => command.name === "sessions"), false)
  assert.equal(fallbackSlashCommands.some((command) => command.name === "model"), false)
  const parsed = parseSlashCommands([
    { name: "sessions", description: "List recent sessions", usage: "/sessions" },
    { name: "model", description: "Choose a model" },
    { name: "status", description: "Show status", usage: "/status" },
  ])
  assert.deepEqual(parsed.map((command) => command.name), ["status"])
})

test("parseSlashInput splits the name and trims the argument", () => {
  assert.deepEqual(parseSlashInput("/Help  status "), { name: "help", argument: "status" })
  assert.deepEqual(parseSlashInput("/goal ship it\nnow"), { name: "goal", argument: "ship it\nnow" })
  assert.deepEqual(parseSlashInput("/compact"), { name: "compact", argument: "" })
  assert.equal(parseSlashInput("hello /compact"), undefined)
  assert.equal(parseSlashInput("/"), undefined)
})

test("Desktop local commands do not require a project or Runtime", () => {
  const context = {
    settings: { model: "gpt-test", baseUrl: "https://example.test/v1", reasoningEffort: "high", hasApiKey: true },
    runtime: { status: "stopped" },
    sessionId: "",
    projectPath: "",
    commands: fallbackSlashCommands,
  }
  const status = executeLocalSlashCommand("/status", context)
  assert.equal(status?.display?.type, "status")
  assert.match(status?.text || "", /Runtime: stopped/)
  const config = executeLocalSlashCommand("/config", context)
  assert.equal(config?.display?.type, "config")
  assert.match(config?.text || "", /apiKey: set/)
  assert.equal(executeLocalSlashCommand("/model", context), undefined)
  assert.equal(executeLocalSlashCommand("/login", context), undefined, "/login is routed to Settings > Providers")
  assert.equal(fallbackSlashCommands.some((command) => command.name === "login"), false)
})

const commands = parseSlashCommands([
  { name: "compact", description: "Compact current context", usage: "/compact", aliases: ["compress"] },
  { name: "invalid command", description: "ignored" },
])

test("slash command menu filters, ranks, and validates the Runtime catalog", () => {
  assert.deepEqual(commands.map((command) => command.name), ["compact"])
  assert.deepEqual(slashCommandMenu(commands, "/co")?.commands.map((command) => command.name), ["compact"])
  assert.deepEqual(slashCommandMenu(commands, "/press")?.commands.map((command) => command.name), ["compact"])
  assert.equal(slashCommandMenu(commands, "/model set"), undefined)
})

test("slash command prefill preserves commands that need arguments", () => {
  const compact = commands.find((command) => command.name === "compact")
  assert.equal(commandPrefill(compact), "/compact")
  assert.equal(isExactSlashCommand(commands, "/compact"), true)
  assert.equal(isExactSlashCommand(commands, "/compress"), true)
  assert.equal(isExactSlashCommand(commands, "/compact now"), false)
})

test("active slash command is revealed with minimal scrolling", () => {
  let options
  revealSlashCommandOption({ scrollIntoView: (next) => { options = next } })
  assert.deepEqual(options, { block: "nearest", inline: "nearest" })
  revealSlashCommandOption(null)
})
