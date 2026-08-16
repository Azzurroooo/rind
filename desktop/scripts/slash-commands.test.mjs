import assert from "node:assert/strict"
import test from "node:test"

import {
  commandPrefill,
  isExactSlashCommand,
  parseSlashCommands,
  slashCommandMenu,
} from "../src/renderer/slash-commands.ts"

const commands = parseSlashCommands([
  { name: "compact", description: "Compact current context", usage: "/compact", aliases: ["compress"] },
  { name: "model", description: "Choose a model", usage: "/model | /model set <model>" },
  { name: "invalid command", description: "ignored" },
])

test("slash command menu filters, ranks, and validates the Runtime catalog", () => {
  assert.deepEqual(commands.map((command) => command.name), ["compact", "model"])
  assert.deepEqual(slashCommandMenu(commands, "/co")?.commands.map((command) => command.name), ["compact"])
  assert.deepEqual(slashCommandMenu(commands, "/press")?.commands.map((command) => command.name), ["compact"])
  assert.equal(slashCommandMenu(commands, "/model set"), undefined)
})

test("slash command prefill preserves commands that need arguments", () => {
  const compact = commands.find((command) => command.name === "compact")
  const model = commands.find((command) => command.name === "model")
  assert.equal(commandPrefill(compact), "/compact")
  assert.equal(commandPrefill(model), "/model ")
  assert.equal(isExactSlashCommand(commands, "/compact"), true)
  assert.equal(isExactSlashCommand(commands, "/compress"), true)
  assert.equal(isExactSlashCommand(commands, "/compact now"), false)
})
