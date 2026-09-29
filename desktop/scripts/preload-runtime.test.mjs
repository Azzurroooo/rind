import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"
import test from "node:test"
import ts from "typescript"
import * as ipcError from "../src/shared/ipc-error.ts"
import * as types from "../src/preload/types.ts"

test("the preload rejects asynchronous worker errors instead of treating them as success", async () => {
  let api
  let result = { session_id: "s1" }
  const source = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const electron = {
    contextBridge: { exposeInMainWorld(_name, value) { api = value } },
    ipcRenderer: { invoke: async () => result },
  }
  runInNewContext(compiled, {
    exports: {},
    process: { platform: "win32" },
    require(id) {
      if (id === "electron") return electron
      if (id === "../shared/ipc-error") return ipcError
      if (id === "./types") return types
      throw new Error(`Unexpected import ${id}`)
    },
  })
  assert.deepEqual(await api.runtime.request("session/prompt", { session_id: "s1", input: "hello" }), result)
  const error = new Error("The requested turn is no longer active.")
  error.name = "TurnNotActive"
  result = ipcError.wrapRuntimeIpcError(error)
  await assert.rejects(api.runtime.request("rind/session/follow_up", { session_id: "s1" }), { name: "TurnNotActive", message: error.message })
})
