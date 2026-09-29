import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { request as httpRequest } from "node:http"
import { WebSocket } from "ws"
import { DesktopGateway } from "../src/main/gateway/server.ts"
import { workspaceFileRequest } from "../src/main/gateway/files.ts"

test("desktop gateway authenticates, isolates sessions, revokes access and serves the web build", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rind-gateway-test-"))
  const listeners = new Set()
  const requests = []
  const web = join(dir, "web")
  const project = join(dir, "project")
  await mkdir(web); await mkdir(project)
  await writeFile(join(web, "index.html"), "<!doctype html><title>Rind</title>")
  await writeFile(join(project, "README.md"), "correct session workspace")
  const bridge = {
    initialize: async () => ({ session_id: "s1", protocol_version: "2", methods: [], capabilities: [], workspace_root: "WRONG_STARTUP_WORKSPACE" }),
    request: async (method, params) => { requests.push([method, params]); return method === "session/switch" ? { session_id: params.session_id, workspace_root: project } : { echoed: params, method } },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const gateway = new DesktopGateway(bridge, web)
  t.after(async () => { await gateway.stop(); await rm(dir, { recursive: true, force: true }) })
  const state = await gateway.start({ scope: "loopback", port: 0 })
  const origin = state.addresses[0]
  assert.equal(state.running, true)
  assert.ok(state.accessCode.length >= 32)
  const page = await fetch(origin)
  assert.equal(page.status, 200)
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/)
  assert.match(await page.text(), /Rind/)
  assert.equal((await fetch(`${origin}/ticket`)).status, 401)
  assert.equal((await fetch(`${origin}/ticket`, { headers: { Authorization: `Bearer ${state.accessCode}`, Origin: "https://attacker.invalid" } })).status, 403)
  const invalidHostStatus = await new Promise((resolve, reject) => { const request = httpRequest(`${origin}/ticket`, { headers: { Host: "attacker.invalid" } }, (response) => { response.resume(); resolve(response.statusCode) }); request.on("error", reject); request.end() })
  assert.equal(invalidHostStatus, 403)
  assert.equal((await fetch(`${origin}/missing.js`)).status, 404)

  async function ticket(code = gateway.state().accessCode) {
    const response = await fetch(`${origin}/ticket`, { headers: { Authorization: `Bearer ${code}` } })
    assert.equal(response.status, 200)
    return (await response.json()).ticket
  }
  async function connect() {
    const value = await ticket()
    const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${value}`, { origin })
    await once(ws, "open")
    t.after(() => ws.terminate())
    let sequence = 0
    const pending = new Map()
    const events = []
    ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (message.kind === "event") events.push(message); else { pending.get(message.request_id)?.(message); pending.delete(message.request_id) } })
    const request = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ kind: "request", request_id: id, method, params })) })
    return { ws, value, request, events }
  }
  const first = await connect()
  const second = await connect()
  assert.equal(gateway.state().clients, 2)
  await first.request("initialize"); await second.request("initialize")
  await second.request("session/unsubscribe", { session_id: "s1" })
  await second.request("session/subscribe", { session_id: "s2" })
  for (const listener of listeners) listener({ type: "assistant_delta", sequence: 1, durability: "incremental", sessionId: "s1", turnId: "t1", event: { type: "assistant_delta", text: "hello" } })
  await first.request("ping"); await second.request("ping")
  assert.equal(first.events.length, 1); assert.equal(second.events.length, 0)
  assert.equal(requests.some(([method]) => method === "session/unsubscribe"), false, "remote unsubscribe must never remove desktop subscriptions")
  const [a, b] = await Promise.all([first.request("session/replay", { session_id: "s1" }), second.request("session/replay", { session_id: "s2" })])
  assert.equal(a.result.echoed.session_id, "s1"); assert.equal(b.result.echoed.session_id, "s2")
  assert.ok((await first.request("shutdown")).error)
  assert.ok((await first.request("rind/auth/update")).error)
  assert.ok((await first.request("session/prompt", { input: "no session" })).error)
  const file = await first.request("file/read", { session_id: "s2", path: "README.md" })
  assert.equal(Buffer.from(file.result.content_base64, "base64").toString(), "correct session workspace")
  assert.ok((await first.request("file/read", { session_id: "s1", path: "../web/index.html" })).error)
  const reused = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${first.value}`)
  const [error] = await once(reused, "error")
  assert.match(error.message, /401/)
  const oldCode = state.accessCode
  const oldTicket = await ticket()
  const closed = once(first.ws, "close")
  gateway.rotate()
  assert.equal((await closed)[0], 4401)
  assert.notEqual(gateway.state().accessCode, oldCode)
  assert.equal((await fetch(`${origin}/ticket`, { headers: { Authorization: `Bearer ${oldCode}` } })).status, 401)
  const revoked = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${oldTicket}`)
  assert.match((await once(revoked, "error"))[0].message, /401/)
  const fresh = await connect()
  assert.equal((await fresh.request("ping")).result.ok, true)
  await gateway.stop()
  assert.equal(gateway.state().running, false); assert.equal(gateway.state().accessCode, "")
  assert.equal(listeners.size, 0)
  assert.equal(requests.some(([method]) => method === "shutdown"), false)
})

test("gateway files restrict writes, sizes, traversal, symlinks and overwrite", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rind-gateway-files-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, "root"), outside = join(dir, "outside")
  await mkdir(root); await mkdir(outside)
  await writeFile(join(outside, "secret.txt"), "outside")
  const data = Buffer.from("hello").toString("base64")
  const write = (path, content_base64 = data) => workspaceFileRequest(root, "file/write", { path, content_base64 })
  assert.deepEqual(await write("uploads/phone/test.txt"), { path: "uploads/phone/test.txt", size: 5 })
  await assert.rejects(write("uploads/phone/test.txt"), /EEXIST/)
  await assert.rejects(write("settings.json"), /uploads/)
  await assert.rejects(write("uploads/../../outside/file.txt"), /relative/)
  await assert.rejects(write("uploads/a.txt", "!bad!"), /Invalid upload/)
  await assert.rejects(write("uploads/large.txt", "A".repeat(9 * 1024 * 1024)), /6 MB/)
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
  await symlink(outside, join(root, "uploads", "escape"), process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(workspaceFileRequest(root, "file/read", { path: "escape/secret.txt" }), /outside/)
  await assert.rejects(write("uploads/escape/new.txt"), /outside/)
  const listing = await workspaceFileRequest(root, "file/list", {})
  assert.equal(listing.entries.some((entry) => entry.name === "escape"), false)
})

test("failed gateway startup is retryable and never leaves credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rind-gateway-retry-"))
  const gateway = new DesktopGateway({ initialize: async () => ({}), request: async () => ({}), subscribe: () => () => {} }, dir)
  t.after(async () => { await gateway.stop(); await rm(dir, { recursive: true, force: true }) })
  await assert.rejects(gateway.start({ scope: "loopback", port: 0 }))
  assert.equal(gateway.state().accessCode, "")
  await writeFile(join(dir, "index.html"), "Rind")
  assert.equal((await gateway.start({ scope: "loopback", port: 0 })).running, true)
})

test("gateway accepts and previews a full 6 MB attachment without overflowing validation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rind-gateway-large-upload-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = Buffer.alloc(6 * 1024 * 1024, 0xa5)
  const uploaded = await workspaceFileRequest(root, "file/write", { path: "uploads/large.png", content_base64: data.toString("base64") })
  assert.equal(uploaded.size, data.length)
  const preview = await workspaceFileRequest(root, "file/read", { path: uploaded.path })
  assert.equal(preview.size, data.length)
  assert.deepEqual(Buffer.from(preview.content_base64, "base64"), data)
  await assert.rejects(workspaceFileRequest(root, "file/write", { path: "uploads/invalid.txt", content_base64: "AB==" }), /Invalid upload/)
})

test("gateway reclaims unresponsive devices while keeping healthy connections", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rind-gateway-heartbeat-"))
  await writeFile(join(root, "index.html"), "Rind")
  t.mock.timers.enable({ apis: ["setInterval"] })
  const gateway = new DesktopGateway({ initialize: async () => ({}), request: async () => ({}), subscribe: () => () => {} }, root)
  t.after(async () => { await gateway.stop(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }) })
  const state = await gateway.start({ scope: "loopback", port: 0 })
  const origin = state.addresses[0]
  async function connect(autoPong) {
    const result = await fetch(`${origin}/ticket`, { headers: { Authorization: `Bearer ${state.accessCode}` } })
    const { ticket } = await result.json()
    const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${ticket}`, { autoPong })
    t.after(() => ws.terminate())
    await once(ws, "open")
    return ws
  }
  const healthy = await connect(true)
  const stalled = await connect(false)
  const firstPing = once(healthy, "ping")
  t.mock.timers.tick(30000)
  await firstPing
  // The request follows the automatic pong on the same ordered socket.
  const response = once(healthy, "message")
  healthy.send(JSON.stringify({ kind: "request", request_id: 1, method: "ping", params: {} }))
  assert.equal(JSON.parse((await response)[0].toString()).result.ok, true)
  const closed = once(stalled, "close")
  const nextPing = once(healthy, "ping")
  t.mock.timers.tick(30000)
  await Promise.all([closed, nextPing])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(healthy.readyState, WebSocket.OPEN)
  assert.equal(gateway.state().clients, 1)
})

test("stopping during gateway startup leaves no server or access code", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rind-gateway-cancel-"))
  await writeFile(join(dir, "index.html"), "Rind")
  const gateway = new DesktopGateway({ initialize: async () => ({}), request: async () => ({}), subscribe: () => () => {} }, dir)
  t.after(async () => { await gateway.stop(); await rm(dir, { recursive: true, force: true }) })
  const starting = gateway.start({ scope: "loopback", port: 0 })
  const rejection = assert.rejects(starting, /cancelled/)
  await gateway.stop()
  await rejection
  assert.equal(gateway.state().running, false)
  assert.equal(gateway.state().accessCode, "")
  assert.equal((await gateway.start({ scope: "loopback", port: 0 })).running, true)
})
