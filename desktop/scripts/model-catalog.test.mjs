import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { listAvailableModels, modelListUrl } from "../src/main/model-catalog.ts"
import { hasCompleteProjectSettings, loadSettingsForWorkspace } from "../src/main/runtime-settings.ts"

test("model catalog preserves the configured API version path and authenticates the request", async () => {
  let request
  const models = await listAvailableModels(
    { apiKey: "secret", baseUrl: "https://models.example.test/v1" },
    async (input, init) => {
      request = { input, init }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }, { id: "gpt-5" }, { id: "" }] }) }
    },
  )

  assert.equal(request.input, "https://models.example.test/v1/models")
  assert.deepEqual(request.init.headers, { Accept: "application/json", Authorization: "Bearer secret" })
  assert.deepEqual(models, ["gpt-5", "gpt-5-mini"])
})

test("model catalog uses the OpenAI default endpoint when Base URL is blank", () => {
  assert.equal(modelListUrl(""), "https://api.openai.com/v1/models")
})

test("model catalog reports malformed and failed provider responses without exposing settings", async () => {
  await assert.rejects(
    () => listAvailableModels({ apiKey: "secret", baseUrl: "https://models.example.test/v1" }, async () => ({ ok: false, status: 401, json: async () => ({}) })),
    /HTTP 401/,
  )
  await assert.rejects(
    () => listAvailableModels({ apiKey: "secret", baseUrl: "https://models.example.test/v1" }, async () => ({ ok: true, status: 200, json: async () => ({}) })),
    /did not include models/,
  )
})

test("project settings override user settings only when the core API config is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rind-desktop-settings-"))
  try {
    const userPath = join(directory, "user", "settings.json")
    const projectPath = join(directory, "project")
    await mkdir(join(projectPath, ".rind"), { recursive: true })
    await mkdir(join(directory, "user"), { recursive: true })
    await writeFile(userPath, JSON.stringify({ apiKey: "user-key", baseUrl: "https://user.example/v1", model: "user-model" }))
    await writeFile(join(projectPath, ".rind", "settings.json"), JSON.stringify({ apiKey: "project-key", baseUrl: "https://project.example/v1", model: "project-model" }))

    const selected = await loadSettingsForWorkspace(userPath, projectPath)
    assert.equal(selected.apiKey, "project-key")
    assert.equal(selected.baseUrl, "https://project.example/v1")
    assert.equal(hasCompleteProjectSettings(selected), true)

    await writeFile(join(projectPath, ".rind", "settings.json"), JSON.stringify({ apiKey: "", baseUrl: "https://project.example/v1", model: "project-model" }))
    const fallback = await loadSettingsForWorkspace(userPath, projectPath)
    assert.equal(fallback.apiKey, "user-key")
    assert.equal(fallback.baseUrl, "https://user.example/v1")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
