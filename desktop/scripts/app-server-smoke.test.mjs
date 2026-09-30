import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { dirname, join, resolve } from "node:path"
import readline from "node:readline"
import test from "node:test"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { WebSocket } from "ws"
import { DesktopGateway } from "../src/main/gateway/server.ts"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("real app-server supports desktop and remote browser session lifecycles", async () => {
  const home = await mkdtemp(join(tmpdir(), "rind-desktop-smoke-"))
  const rindHome = join(home, ".rind")
  await mkdir(rindHome, { recursive: true })
  await writeFile(join(rindHome, "settings.json"), JSON.stringify({ apiKey: "desktop-smoke-key" }), "utf8")
  const runtime = spawn(process.env.RIND_PYTHON || "python", ["main.py", "app-server", "--stdio", "--cwd", repoRoot], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RIND_HOME: rindHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const exit = once(runtime, "exit")
  const responses = new Map()
  const lines = readline.createInterface({ input: runtime.stdout })
  const listeners = new Set()
  lines.on("line", (line) => {
    const message = JSON.parse(line)
    if (message.kind === "event") for (const listener of listeners) listener({ sessionId: message.session_id, sequence: message.sequence, durability: message.durability, turnId: message.turn_id, event: message.event })
    const pending = responses.get(String(message.request_id))
    if (pending) {
      responses.delete(String(message.request_id))
      clearTimeout(pending.timer)
      pending.resolve(message)
    }
  })

  function request(requestId, method, params = {}) {
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        responses.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}.`))
      }, 15_000)
      responses.set(requestId, { resolve: resolveRequest, timer })
      runtime.stdin.write(`${JSON.stringify({ kind: "request", request_id: requestId, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        responses.delete(requestId)
        reject(error)
      })
    })
  }

  let gateway, ws
  try {
    const initialize = await request("initialize", "initialize")
    assert.equal(initialize.kind, "response")
    assert.equal(initialize.result.protocol_version, "2")
    assert.ok(initialize.result.capabilities.includes("sessions"))
    assert.ok(initialize.result.methods.includes("session/new"))
    assert.equal(typeof initialize.result.session_id, "string")
    assert.equal(initialize.result.draft, true)
    await assert.rejects(access(join(rindHome, "sessions", initialize.result.session_id)), { code: "ENOENT" })
    assert.ok(initialize.result.methods.includes("rind/background/list"))

    const listed = await request("sessions", "session/list", { limit: 10 })
    assert.equal(listed.error, undefined)
    assert.ok(Array.isArray(listed.result.sessions))

    const created = await request("new", "session/new")
    assert.equal(typeof created.result.session_id, "string")
    assert.equal(created.result.draft, false)

    const replay = await request("replay", "session/replay", { session_id: created.result.session_id })
    assert.equal(replay.error, undefined)
    assert.ok(Array.isArray(replay.result.messages))

    // Use the real worker through the same HTTP/ticket/WebSocket chain as a phone.
    const webRoot = join(home, "web")
    await mkdir(webRoot)
    await writeFile(join(webRoot, "index.html"), '<script src="/app.js"></script>')
    await writeFile(join(webRoot, "app.js"), "window.rind = true")
    let gatewaySequence = 0
    gateway = new DesktopGateway({
      initialize: async () => (await request(`g-${++gatewaySequence}`, "initialize")).result,
      request: async (method, params) => {
        const response = await request(`g-${++gatewaySequence}`, method, params)
        if (response.error) throw new Error(response.error.message)
        return response.result
      },
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    }, webRoot)
    const remote = await gateway.start({ scope: "lan", port: 0 })
    const origin = remote.addresses[0]
    assert.equal((await fetch(origin)).status, 200)
    assert.match(await (await fetch(`${origin}/app.js`)).text(), /window.rind/)
    const { ticket } = await (await fetch(`${origin}/ticket`, { headers: { Authorization: `Bearer ${remote.accessCode}` } })).json()
    ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${ticket}`, { origin })
    await once(ws, "open")
    async function remoteRequest(method, params = {}) {
      const response = once(ws, "message")
      ws.send(JSON.stringify({ kind: "request", request_id: ++gatewaySequence, method, params }))
      const message = JSON.parse((await response)[0].toString())
      assert.equal(message.error, undefined, `${method}: ${message.error?.message}`)
      return message.result
    }
    const remoteInit = await remoteRequest("initialize")
    assert.equal(new Set(remoteInit.methods).size, remoteInit.methods.length)
    assert.ok(remoteInit.methods.includes("rind/auth/list"))
    assert.ok(remoteInit.methods.includes("model/list"))
    assert.ok(!remoteInit.methods.includes("rind/auth/login"))
    assert.ok(Array.isArray((await remoteRequest("rind/auth/list")).providers))
    assert.ok((await remoteRequest("rind/usage/summary", { days: 7 })).totals)
    assert.ok(Array.isArray((await remoteRequest("session/list")).sessions))
    assert.ok(Array.isArray((await remoteRequest("session/replay", { session_id: created.result.session_id })).messages))
    assert.ok(Array.isArray((await remoteRequest("rind/task/list", { session_id: created.result.session_id })).tasks))
    ws.terminate()
    await gateway.stop()

    const shutdown = await request("shutdown", "shutdown")
    assert.deepEqual(shutdown.result, { ok: true })
    const [code] = await exit
    assert.equal(code, 0)
  } finally {
    ws?.terminate()
    await gateway?.stop()
    if (runtime.exitCode === null) runtime.kill()
    lines.close()
    await rm(home, { recursive: true, force: true })
  }
})
