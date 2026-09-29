import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import test from "node:test"
import ts from "typescript"

import * as ipcError from "../src/shared/ipc-error.ts"
import * as types from "../src/preload/types.ts"
import { buildAuthReply, maxAuthReplyChars, parseAuthPrompt, parseAuthUpdate, validateAuthReply } from "../src/main/auth-messages.ts"
import { isDesktopRuntimeMethod, isRemoteRuntimeMethod } from "../src/main/method-policy.ts"

const { runtimeMethods, sessionScopedMethods, localOnlyRuntimeMethods } = types

test("auth changes are available to the desktop but never to remote clients", () => {
  assert.equal(isRemoteRuntimeMethod("rind/auth/list"), true, "remote clients may read provider status")
  assert.equal(localOnlyRuntimeMethods.has("rind/auth/list"), false)
  for (const method of ["rind/auth/login", "rind/auth/logout"]) {
    assert.equal(isDesktopRuntimeMethod(method), true, `${method} must pass the desktop allowlist`)
    assert.equal(isRemoteRuntimeMethod(method), false, `${method} must be refused by the gateway`)
    assert.equal(localOnlyRuntimeMethods.has(method), true)
  }
  assert.equal(isRemoteRuntimeMethod("session/prompt"), true, "ordinary methods still reach remote clients")
  assert.equal(isRemoteRuntimeMethod("initialize"), false)
  assert.equal(isDesktopRuntimeMethod(42), false)
  assert.equal(sessionScopedMethods.has(runtimeMethods.authLogin), true, "login requires a session id")
})

test("auth prompts are parsed defensively", () => {
  const prompt = parseAuthPrompt({
    kind: "request",
    request_id: "auth-1",
    method: "rind/auth/prompt",
    params: { kind: "secret", message: "OpenAI API key", options: [] },
  })
  assert.deepEqual(prompt, { requestId: "auth-1", kind: "secret", message: "OpenAI API key", options: [] })
  assert.equal(parseAuthPrompt({ kind: "response", request_id: "auth-1", method: "rind/auth/prompt" }), undefined)
  assert.equal(parseAuthPrompt({ kind: "request", request_id: "", method: "rind/auth/prompt" }), undefined)
  assert.equal(parseAuthPrompt({ kind: "request", request_id: "x", method: "session/prompt" }), undefined)
  const select = parseAuthPrompt({
    kind: "request",
    request_id: "auth-2",
    method: "rind/auth/prompt",
    params: { kind: "shell", message: 7, options: ["a", { value: "b" }, 3, ""] },
  })
  assert.equal(select.kind, "text", "unknown prompt kinds fall back to text")
  assert.equal(select.message, "")
  assert.deepEqual(select.options, ["a", "b"])
})

test("auth updates keep their payload and gain a string type", () => {
  assert.deepEqual(parseAuthUpdate({ kind: "event", method: "rind/auth/update", event: { provider_id: "p" } }), { provider_id: "p", type: "" })
  assert.equal(parseAuthUpdate({ kind: "event", method: "session/update", event: {} }), undefined)
})

test("auth replies must target a pending prompt and stay bounded", () => {
  const pending = new Set(["auth-1"])
  assert.deepEqual(validateAuthReply(pending, "auth-1", "sk"), { requestId: "auth-1", value: "sk" })
  assert.throws(() => validateAuthReply(pending, "auth-2", "sk"), /Unknown auth prompt/)
  assert.throws(() => validateAuthReply(pending, "auth-1", 5), /must be text/)
  assert.throws(() => validateAuthReply(pending, "auth-1", "x".repeat(maxAuthReplyChars + 1)), /too long/)
  assert.deepEqual(buildAuthReply("auth-1", ""), { kind: "request", request_id: "auth-1", method: "rind/auth/prompt", params: { value: "" } })
})

test("the preload bridge exposes auth through the runtime channel", async () => {
  let api
  const calls = []
  const listeners = new Map()
  const source = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const electron = {
    contextBridge: { exposeInMainWorld(_name, value) { api = value } },
    ipcRenderer: {
      invoke: async (...args) => {
        calls.push(args)
        return args[1] === "rind/auth/list" ? { providers: [{ id: "openai" }] } : true
      },
      on: (channel, handler) => listeners.set(channel, handler),
      removeListener: (channel) => listeners.delete(channel),
    },
  }
  runInNewContext(compiled, {
    exports: {},
    process: { platform: "darwin" },
    require(id) {
      if (id === "electron") return electron
      if (id === "../shared/ipc-error") return ipcError
      if (id === "./types") return types
      throw new Error(`Unexpected import ${id}`)
    },
  })
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(await api.auth.list()), [{ id: "openai" }])
  await api.auth.login("s1", "openai")
  await api.auth.logout("openai")
  await api.auth.respond("auth-1", "sk")
  assert.deepEqual(plain(calls.slice(1)), [
    ["runtime-request", "rind/auth/login", { session_id: "s1", provider_id: "openai", method: "api_key" }],
    ["runtime-request", "rind/auth/logout", { provider_id: "openai" }],
    ["auth-prompt-respond", "auth-1", "sk"],
  ])
  const received = []
  const unsubscribe = api.auth.onPrompt((prompt) => received.push(prompt))
  listeners.get("auth-prompt")({}, { requestId: "auth-9" })
  unsubscribe()
  assert.deepEqual(plain(received), [{ requestId: "auth-9" }])
  assert.equal(listeners.has("auth-prompt"), false)
})

test("a login round-trips an interactive prompt through the worker", async () => {
  const originalRuntimePath = process.env.RIND_RUNTIME_PATH
  const testDirectory = await mkdtemp(join(tmpdir(), "rind-auth-test-"))
  const workspace = join(testDirectory, "workspace")
  await mkdir(workspace, { recursive: true })
  process.env.RIND_RUNTIME_PATH = join(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs")
  const runtime = await import("../src/main/runtime.ts")
  try {
    runtime.startRuntime(workspace)
    await runtime.initializeRuntime()
    const prompts = []
    const updates = []
    const stopPrompts = runtime.subscribeAuthPrompts((prompt) => {
      prompts.push(prompt)
      void runtime.respondAuthPrompt(prompt.requestId, prompts.length === 1 ? "sk-test" : "")
    })
    const stopUpdates = runtime.subscribeAuthUpdates((update) => updates.push(update))

    const listed = await runtime.requestRuntime("rind/auth/list", {})
    assert.equal(listed.providers[0].configured, false)
    const login = await runtime.requestRuntime("rind/auth/login", { session_id: "s1", provider_id: "openai", method: "api_key" })
    assert.deepEqual(login, { ok: true, provider_id: "openai", models_count: 3, selection: null })
    assert.equal(prompts[0].kind, "secret")
    assert.equal(updates[0].type, "auth_configured")
    await assert.rejects(runtime.respondAuthPrompt(prompts[0].requestId, "again"), /Unknown auth prompt/, "answered prompts cannot be replayed")

    await assert.rejects(
      runtime.requestRuntime("rind/auth/login", { session_id: "s1", provider_id: "openai", method: "api_key" }),
      { name: "AuthCancelled" },
      "an empty answer cancels the login",
    )
    const logout = await runtime.requestRuntime("rind/auth/logout", { provider_id: "openai" })
    assert.equal(logout.deleted, true)
    stopPrompts()
    stopUpdates()
  } finally {
    await runtime.shutdownRuntime()
    if (originalRuntimePath === undefined) delete process.env.RIND_RUNTIME_PATH
    else process.env.RIND_RUNTIME_PATH = originalRuntimePath
    await rm(testDirectory, { recursive: true, force: true })
  }
})
