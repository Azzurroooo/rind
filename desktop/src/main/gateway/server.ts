import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { hostname } from "node:os"
import { extname, relative, resolve, sep } from "node:path"
import { WebSocket, WebSocketServer } from "ws"
import type { GatewayOptions, GatewayState, RuntimeEvent } from "../../preload/types.ts"
import { workspaceFileRequest } from "./files.ts"
import { localAddresses, outboundAddress } from "./network.ts"
import { isRemoteRuntimeMethod } from "../method-policy.ts"
import { runtimeMethods } from "../../preload/types.ts"

type Bridge = {
  initialize: () => Promise<unknown>
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void
}
type Client = { subscriptions: Set<string>; pending: Set<string | number>; selected: string; workspace: string; alive: boolean }
const allowed = new Set(Object.values(runtimeMethods).filter(isRemoteRuntimeMethod))
const unscoped = new Set(["session/new", "session/list", "rind/usage/summary", "rind/auth/list", "model/list"])
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" }
const secret = () => randomBytes(24).toString("base64url")
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

export class DesktopGateway {
  private server?: Server
  private sockets?: WebSocketServer
  private unsubscribe?: () => void
  private accessCode = ""
  private tickets = new Map<string, number>()
  private attempts = new Map<string, { count: number; expires: number }>()
  private clients = new Map<WebSocket, Client>()
  private allowedHosts = new Set<string>()
  private options: GatewayOptions = { scope: "loopback" }
  private addresses: string[] = []
  private port = 0
  private epoch = 0
  private starting = false
  private stopping?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private readonly bridge: Bridge
  private readonly webRoot: string
  private readonly changed: (state: GatewayState) => void
  constructor(bridge: Bridge, webRoot: string, changed: (state: GatewayState) => void = () => {}) {
    this.bridge = bridge; this.webRoot = webRoot; this.changed = changed
  }

  state(): GatewayState { return { running: Boolean(this.server?.listening), scope: this.options.scope, port: this.port, addresses: [...this.addresses], accessCode: this.accessCode, clients: this.clients.size } }
  private publish() { this.changed(this.state()) }

  async start(options: GatewayOptions): Promise<GatewayState> {
    if (this.starting || this.stopping) throw new Error("Remote access is changing. Try again shortly.")
    if (this.server?.listening) return this.state()
    if (!options || !["loopback", "lan"].includes(options.scope)) throw new Error("Choose local network or this computer.")
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error("Invalid port.")
    let external: URL | undefined
    if (options.externalOrigin) {
      external = new URL(options.externalOrigin)
      if (external.protocol !== "https:" || external.username || external.password || external.pathname !== "/" || external.search || external.hash) throw new Error("Enter an HTTPS origin, without a path or credentials.")
    }
    this.starting = true
    const startEpoch = ++this.epoch
    try {
      try { await stat(resolve(this.webRoot, "index.html")) }
      catch { throw new Error("Web client is missing. Run npm run build:web in desktop, then try again.") }
      if (startEpoch !== this.epoch) throw new Error("Remote access startup cancelled.")
      await this.bridge.initialize()
      if (startEpoch !== this.epoch) throw new Error("Remote access startup cancelled.")
      this.options = { ...options, externalOrigin: external?.origin }
      this.accessCode = secret()
      const hosts = new Set(["localhost", "127.0.0.1", "[::1]", hostname().toLowerCase()])
      const local = options.scope === "lan" ? localAddresses(undefined, await outboundAddress()).map((entry) => entry.address) : []
      if (startEpoch !== this.epoch) throw new Error("Remote access startup cancelled.")
      for (const address of local) hosts.add(address)
      if (external) hosts.add(external.hostname)
      this.allowedHosts = hosts
      const server = createServer((request, response) => { void this.http(request, response).catch(() => { if (!response.headersSent) this.json(response, 500, { error: "Unable to serve this request." }); else response.end() }) })
      server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 64
      const sockets = new WebSocketServer({ noServer: true, maxPayload: 9 * 1024 * 1024, perMessageDeflate: false })
      this.server = server; this.sockets = sockets
      server.on("upgrade", (request, socket, head) => {
        const address = this.requestUrl(request)
        const ticket = address?.searchParams.get("ticket") || ""
        const expires = this.tickets.get(ticket) || 0
        this.tickets.delete(ticket)
        if (!address || address.pathname !== "/ws" || !this.validOrigin(request) || expires <= Date.now() || this.clients.size >= 16) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return }
        sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws))
      })
      await new Promise<void>((resolveReady, reject) => { server.once("error", reject); server.listen(options.port ?? 8766, options.scope === "lan" ? "0.0.0.0" : "127.0.0.1", () => { server.removeListener("error", reject); resolveReady() }) })
      if (startEpoch !== this.epoch) {
        await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
        throw new Error("Remote access startup cancelled.")
      }
      server.on("error", () => { void this.stop() })
      const address = server.address()
      this.port = typeof address === "object" && address ? address.port : 0
      this.addresses = [...(external ? [external.origin] : []), ...[...local].map((host) => `http://${host}:${this.port}`), `http://127.0.0.1:${this.port}`]
      this.heartbeat = setInterval(() => {
        for (const [ws, client] of this.clients) {
          if (!client.alive) { ws.terminate(); continue }
          client.alive = false
          if (ws.readyState === WebSocket.OPEN) ws.ping()
        }
      }, 30000)
      this.heartbeat.unref()
      this.unsubscribe = this.bridge.subscribe((event) => {
        for (const [ws, client] of this.clients) if (client.subscriptions.has(event.sessionId)) this.send(ws, { kind: "event", method: "session/update", sequence: event.sequence, durability: event.durability, session_id: event.sessionId, turn_id: event.turnId, event: event.event })
      })
      this.publish(); return this.state()
    } catch (error) { await this.stop(); throw error }
    finally { this.starting = false }
  }

  rotate(): GatewayState {
    if (!this.server?.listening) throw new Error("Enable remote access first.")
    ++this.epoch; this.accessCode = secret(); this.tickets.clear(); this.attempts.clear()
    for (const ws of this.clients.keys()) ws.close(4401, "Access code changed")
    this.clients.clear(); this.publish(); return this.state()
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.close()
    try { await this.stopping } finally { this.stopping = undefined }
  }
  private async close() {
    ++this.epoch; this.unsubscribe?.(); this.unsubscribe = undefined
    clearInterval(this.heartbeat); this.heartbeat = undefined
    this.tickets.clear(); this.attempts.clear(); this.accessCode = ""
    for (const ws of this.clients.keys()) ws.terminate()
    this.clients.clear(); this.sockets?.close(); this.sockets = undefined
    const server = this.server; this.server = undefined
    if (server?.listening) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
    this.port = 0; this.addresses = []; this.publish()
  }

  private requestUrl(request: IncomingMessage) {
    try {
      const path = request.url || "/"
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null
      const host = new URL(`http://${request.headers.host}`)
      if (host.username || host.password || host.host !== request.headers.host?.toLowerCase() || !this.allowedHosts.has(host.hostname.toLowerCase())) return null
      return new URL(path, host)
    } catch { return null }
  }
  private validOrigin(request: IncomingMessage) {
    if (!request.headers.origin) return true // CLI clients do not send Origin.
    try {
      const origin = new URL(request.headers.origin)
      if (origin.origin === this.options.externalOrigin) return true
      return ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host && this.allowedHosts.has(origin.hostname.toLowerCase())
    } catch { return false }
  }
  private json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value))
  }
  private async http(request: IncomingMessage, response: ServerResponse) {
    const address = this.requestUrl(request)
    if (!address || !this.validOrigin(request)) { this.json(response, 403, { error: "Origin not allowed." }); return }
    if (request.method !== "GET" && request.method !== "HEAD") { this.json(response, 405, { error: "Method not allowed." }); return }
    if (address.pathname === "/healthz") { this.json(response, 200, { ok: true }); return }
    if (address.pathname === "/ticket") {
      const now = Date.now()
      for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key)
      for (const [key, value] of this.tickets) if (value <= now) this.tickets.delete(key)
      const ip = request.socket.remoteAddress || "unknown"
      const attempts = this.attempts.get(ip) || { count: 0, expires: now + 60000 }
      if (++attempts.count > 30 || this.attempts.size > 1024) { this.json(response, 429, { error: "Too many attempts. Try again in a minute." }); return }
      this.attempts.set(ip, attempts)
      const code = Buffer.from(request.headers.authorization?.replace(/^Bearer /i, "") || "")
      const expected = Buffer.from(this.accessCode)
      if (!expected.length || code.length !== expected.length || !timingSafeEqual(code, expected)) { this.json(response, 401, { error: "Access code invalid." }); return }
      if (this.tickets.size >= 128) { this.json(response, 429, { error: "Too many pending connections." }); return }
      const ticket = secret(); this.tickets.set(ticket, now + 60000)
      this.json(response, 200, { ticket }); return
    }
    let path: string
    try {
      const root = await realpath(this.webRoot)
      path = await realpath(resolve(root, `.${decodeURIComponent(address.pathname === "/" ? "/index.html" : address.pathname)}`))
      const rel = relative(root, path)
      if (rel === ".." || rel.startsWith(`..${sep}`) || !mime[extname(path)]) throw new Error("Not found")
    } catch { this.json(response, 404, { error: "Not found." }); return }
    response.writeHead(200, {
      "Content-Type": mime[extname(path)], "Cache-Control": extname(path) === ".html" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    })
    response.end(request.method === "HEAD" ? undefined : await readFile(path))
  }

  private send(ws: WebSocket, message: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, "Slow connection; reconnect to restore history"); return }
    ws.send(JSON.stringify(message))
  }
  private accept(ws: WebSocket) {
    const client: Client = { subscriptions: new Set(), pending: new Set(), selected: "", workspace: "", alive: true }
    const epoch = this.epoch
    this.clients.set(ws, client); this.publish()
    ws.on("pong", () => { client.alive = true })
    ws.on("error", () => ws.terminate())
    ws.on("close", () => { this.clients.delete(ws); this.publish() })
    ws.on("message", (raw, binary) => {
      if (binary || epoch !== this.epoch) { ws.close(4401); return }
      let message: Record<string, unknown>
      try { message = object(JSON.parse(raw.toString())) } catch { ws.close(1007, "Invalid JSON"); return }
      const id = message.request_id
      if (message.kind !== "request" || (typeof id !== "string" && typeof id !== "number") || String(id).length > 128 || typeof message.method !== "string") { ws.close(1008, "Invalid request"); return }
      if (client.pending.has(id) || client.pending.size >= 32) { this.send(ws, { kind: "response", request_id: id, error: { type: "Busy", message: "Too many pending requests or duplicate request id." } }); return }
      client.pending.add(id)
      void this.dispatch(client, message.method, object(message.params)).then((result) => {
        if (epoch === this.epoch) this.send(ws, { kind: "response", request_id: id, result })
      }).catch((error: Error) => {
        if (epoch === this.epoch) this.send(ws, { kind: "response", request_id: id, error: { type: error.name, message: error.message } })
      }).finally(() => client.pending.delete(id))
    })
  }
  private async dispatch(client: Client, method: string, params: Record<string, unknown>) {
    if (method === "ping") return { ok: true }
    if (method === "initialize") {
      const result = object(await this.bridge.initialize())
      client.selected = String(result.session_id || "")
      client.workspace = String(result.workspace_root || "")
      if (client.selected) client.subscriptions.add(client.selected)
      return { ...result, methods: [...new Set([...allowed, "initialize", "ping", "session/subscribe", "session/unsubscribe"])], gateway: { desktop: true, files_follow_session: true } }
    }
    const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : ""
    if (method === "session/unsubscribe") { client.subscriptions.delete(sessionId); return { ok: true } }
    if (method === "session/subscribe") {
      if (!sessionId || client.subscriptions.size >= 128) throw new Error("Invalid session or subscription limit reached.")
      await this.bridge.request("session/subscribe", params); client.subscriptions.add(sessionId); return { ok: true }
    }
    if (method.startsWith("file/")) {
      if (!["file/list", "file/read", "file/write"].includes(method) || !sessionId) throw new Error("Choose a session before browsing files.")
      const session = object(await this.bridge.request("session/switch", { session_id: sessionId }))
      if (typeof session.workspace_root !== "string") throw new Error("Session workspace unavailable.")
      return workspaceFileRequest(session.workspace_root, method, params)
    }
    if (!isRemoteRuntimeMethod(method)) throw new Error("Method is not available through remote access.")
    if (!unscoped.has(method) && !sessionId) throw new Error("session_id is required.")
    if (method === "session/new") {
      const workspace = typeof params.workspace_root === "string" ? params.workspace_root.trim() : client.workspace
      if (!workspace) throw new Error("Choose a project folder on the Rind computer first.")
      params = { ...params, workspace_root: workspace }
    }
    if (sessionId && client.subscriptions.size < 128) client.subscriptions.add(sessionId)
    const result = await this.bridge.request(method, params)
    if (method === "session/switch" || method === "session/new") {
      client.selected = String(object(result).session_id || sessionId)
      client.workspace = String(object(result).workspace_root || params.workspace_root || client.workspace)
      if (client.selected) client.subscriptions.add(client.selected)
    }
    return result
  }
}
