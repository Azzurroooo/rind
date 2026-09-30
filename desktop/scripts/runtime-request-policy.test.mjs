import assert from "node:assert/strict"
import test from "node:test"
import { runtimeRequestTimeout } from "../src/main/runtime-request-policy.ts"

test("direct and slash compaction survive the ordinary RPC timeout through the gateway", () => {
  for (const method of ["rind/session/compact", "rind/command/execute", "session/prompt"]) assert.equal(runtimeRequestTimeout(method), 900_000)
  assert.equal(runtimeRequestTimeout("session/list"), 30_000)
  assert.equal(runtimeRequestTimeout("session/cancel"), 30_000)
})
