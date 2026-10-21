import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { request as httpRequest } from "node:http"
import { DesktopGateway, RemoteWebSocket as WebSocket } from "../../rind-runtime-client/remote/server.js"
import { workspaceFileRequest } from "../../rind-runtime-client/remote/files.js"

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
  await first.request("session/switch", { session_id: "s1" })
  await first.request("session/new")
  assert.equal(requests.at(-1)[1].workspace_root, project, "new sessions use this browser's selected folder")
  await second.request("session/new")
  assert.equal(requests.at(-1)[1].workspace_root, "WRONG_STARTUP_WORKSPACE", "another browser keeps its own default folder")
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

test("gateway proxies agents management requests, binds opened sessions, and broadcasts agents/update events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rind-gateway-agents-"))
  const web = join(dir, "web")
  const agentWorkspace = join(dir, "agent-workspace")
  await mkdir(web)
  await mkdir(agentWorkspace)
  await writeFile(join(web, "index.html"), "Rind")
  await writeFile(join(agentWorkspace, "NOTE.md"), "agent workspace file")
  const agentListeners = new Set()
  const agentCalls = []
  const bridge = {
    initialize: async () => ({ session_id: "s0", protocol_version: "2", methods: ["session/prompt"], capabilities: [] }),
    request: async (method, params) => ({ method, params }),
    subscribe: () => () => {},
    agentsRequest: async (method, params) => {
      agentCalls.push([method, params])
      if (method === "openSession") {
        return {
          managementSessionId: "ms-1",
          agentId: "a-1",
          teamId: "t-1",
          manager: false,
          workspaceRoot: agentWorkspace,
          runtimeSessionId: String(params.runtimeSessionId || ""),
          session: { session_id: String(params.runtimeSessionId || ""), workspace_root: agentWorkspace },
        }
      }
      if (method === "createSession") {
        return {
          session_id: "s-created",
          workspace_root: agentWorkspace,
          managementSessionId: "ms-1",
        }
      }
      return { ok: true, method, params }
    },
    subscribeAgents: (fn) => {
      agentListeners.add(fn)
      return () => agentListeners.delete(fn)
    },
  }
  const gateway = new DesktopGateway(bridge, web)
  t.after(async () => { await gateway.stop(); await rm(dir, { recursive: true, force: true }) })
  const state = await gateway.start({ scope: "loopback", port: 0 })
  const origin = state.addresses[0]
  const ticketRes = await fetch(`${origin}/ticket`, { headers: { Authorization: `Bearer ${state.accessCode}` } })
  const { ticket } = await ticketRes.json()
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${ticket}`, { origin })
  await once(ws, "open")
  t.after(() => ws.terminate())
  let seq = 0
  const pending = new Map()
  const events = []
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.kind === "event") events.push(msg)
    else { pending.get(msg.request_id)?.(msg); pending.delete(msg.request_id) }
  })
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ kind: "request", request_id: id, method, params }))
  })

  const init = await request("initialize")
  assert.equal(init.result.methods.includes("agents/request"), true)
  assert.equal(init.result.capabilities.includes("agents_management"), true)

  // Draft agent session (before runtimeSessionId is created) sets client.workspace so file/list works:
  const openedDraft = await request("agents/openSession", { teamId: "t-1", agentId: "a-1" })
  assert.equal(openedDraft.result.workspaceRoot, agentWorkspace)
  const draftFiles = await request("file/list", {})
  assert.equal(draftFiles.result.entries.some((e) => e.name === "NOTE.md"), true)

  // Creating the session binds client.selected to s-created:
  const created = await request("agents/createSession", { managementSessionId: "ms-1" })
  assert.equal(created.result.session_id, "s-created")

  // Broadcast agents/update and workspace/folder changes:
  for (const fn of agentListeners) fn({ connection: "connected", snapshot: { seq: 5, teams: [{ id: "t-1", name: "Core" }] } })
  gateway.notifyWorkspacesChanged()
  await request("ping")
  assert.equal(events.some((e) => e.method === "agents/update" && e.event.snapshot.seq === 5), true)
  assert.equal(events.some((e) => e.method === "session/update" && e.event?.type === "folder_defaults_changed"), true)
})

test("desktop remote access dialog renders SVG QR code in a sandboxed browser environment without Node Buffer", async () => {
  const { JSDOM } = await import("jsdom")
  const { bindRemoteAccess, remoteAccessMarkup } = await import("../src/renderer/remote-access.ts")
  const dom = new JSDOM(`<!doctype html><body><button id="open-remote"></button>${remoteAccessMarkup()}</body>`)
  const prevWindow = globalThis.window
  const prevDocument = globalThis.document
  const prevHTMLElement = globalThis.HTMLElement
  const prevElement = globalThis.Element
  const prevBuffer = globalThis.Buffer
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  const dialog = dom.window.document.getElementById("remote-dialog")
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false }

  let gatewayState = {
    running: false,
    scope: "lan",
    port: 8766,
    addresses: [],
    accessCode: "",
    clients: 0,
  }
  dom.window.api = {
    platform: "win32",
    gateway: {
      get: async () => gatewayState,
      start: async ({ scope, port }) => {
        gatewayState = {
          running: true,
          scope,
          port,
          addresses: ["http://192.168.1.42:8766", "http://127.0.0.1:8766"],
          accessCode: "secret_access_code_1234567890abcdef",
          clients: 0,
        }
        return gatewayState
      },
      stop: async () => {
        gatewayState = { ...gatewayState, running: false, addresses: [], accessCode: "" }
        return gatewayState
      },
      rotate: async () => gatewayState,
      allowNetwork: async () => gatewayState,
      subscribe: () => () => {},
    },
  }

  try {
    globalThis.Buffer = undefined
    const remote = bindRemoteAccess()
    remote.open()
    await new Promise((resolve) => setTimeout(resolve, 0))

    dom.window.document.getElementById("remote-toggle").click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const qrImg = dom.window.document.getElementById("remote-qr")
    const messageEl = dom.window.document.getElementById("remote-message")
    assert.equal(messageEl.textContent, "")
    assert.equal(qrImg.hidden, false)
    assert.match(qrImg.getAttribute("src") || "", /^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
    remote.dispose()
  } finally {
    globalThis.Buffer = prevBuffer
    globalThis.window = prevWindow
    globalThis.document = prevDocument
    globalThis.HTMLElement = prevHTMLElement
    globalThis.Element = prevElement
    dom.window.close()
  }
})
