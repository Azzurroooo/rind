import assert from "node:assert/strict"
import test from "node:test"

import { listAvailableModels, modelListUrl } from "../src/main/model-catalog.ts"

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
