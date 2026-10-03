// Real Desktop Gateway + isolated fake Worker bridge; no providers or user files.
// Browser routing substitutes only the native HTTP/WS origin transport.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { WebSocket } from "../../desktop/node_modules/ws/wrapper.mjs";
import { DesktopGateway } from "../../desktop/src/main/gateway/server.ts";

const root = await mkdtemp(join(tmpdir(), "rind-mobile-smoke-"));
const listeners = new Set(), requests = [], sockets = new Set(), errors = [];
const workspace = join(root, "workspace");
await mkdir(workspace); await writeFile(join(workspace, "README.md"), "Remote workspace file");
const messages = [{ id: "m1", role: "user", content: "Review the mobile connection flow." }, { id: "m2", role: "assistant", content: "The remote connection is ready. Tasks and files stay on your computer." }];
let sequence = 0, endTurn;
const event = (type, rest = {}) => listeners.forEach((fn) => fn({ sessionId: "s1", turnId: "turn1", sequence: ++sequence, durability: "durable", event: { type, ...rest } }));
const initialize = async () => ({ session_id: "s1", workspace_root: workspace, model: "test-model", protocol_version: "2", capabilities: ["rind/tasks"], reasoning_effort: "medium" });
const bridge = {
  initialize,
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  request: async (method, params) => {
    requests.push({ method, params });
    if (method === "session/switch") return initialize();
    if (method === "session/list") return { sessions: [{ id: "s1", title: "Mobile connection", workspace_root: workspace }] };
    if (method === "session/replay") return { messages, tasks: [], live_turn: null, has_more: false };
    if (method === "model/list") return { models: [{ id: "test-model", provider_id: "test", name: "Test model" }], current_model: "test-model" };
    if (method === "rind/auth/list") return { providers: [{ id: "test", name: "Test provider", configured: true }] };
    if (method === "rind/task/list") return { tasks: [] };
    if (method === "session/prompt") {
      messages.push({ id: "m3", role: "user", content: params.input });
      event("turn_started", { input: params.input, client_input_id: params.client_input_id, turn_id: "turn1" });
      event("assistant_delta", { text: "Working on your remote task." });
      return new Promise((done) => { endTurn = () => {
        messages.push({ id: "m4", role: "assistant", content: "Working on your remote task." });
        event("turn_completed", { turn_id: "turn1" }); done({ session_id: "s1", turn_id: "turn1" });
      }; });
    }
    if (method === "rind/session/follow_up") return { accepted: true, input_id: "queued1", mode: "follow_up" };
    if (method === "session/cancel") { endTurn?.(); return { ok: true }; }
    return {};
  },
};
const gateway = new DesktopGateway(bridge, resolve("dist"));
let server, browser;
try {
  const state = await gateway.start({ scope: "loopback", port: 0 });
  const origin = state.addresses[0];
  server = await preview({ preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  // Use the Android app's real HTTP origin, which is not a secure browser context.
  await page.route("http://rind.local/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.route(`${origin}/ticket`, async (route) => {
    const response = await fetch(`${origin}/ticket`, { headers: { Authorization: route.request().headers().authorization || "" } });
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  });
  await page.routeWebSocket(/\/ws\?ticket=/, (route) => {
    const remote = new WebSocket(route.url(), { origin: "http://rind.local" });
    sockets.add(remote); const queue = [];
    route.onMessage((data) => { if (remote.readyState === WebSocket.OPEN) remote.send(data); else queue.push(data); });
    remote.on("open", () => { for (const data of queue) remote.send(data); });
    remote.on("message", (data) => route.send(data.toString()));
    remote.on("close", (code) => { sockets.delete(remote); route.close({ code: code === 1006 ? 1011 : code }); });
    remote.on("error", () => route.close({ code: 1011 }));
    route.onClose(() => remote.close());
  });
  await page.goto("http://rind.local");
  assert.equal(await page.evaluate(() => isSecureContext), false);
  const shots = process.env.RIND_QA_SHOTS;
  async function screenshot(name) { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" }); } }
  await expect(page.getByRole("button", { name: "Add computer", exact: true })).toBeEnabled();
  await screenshot("home-light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click(); await screenshot("home-dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  await page.getByLabel("Computer name").fill("Development computer");
  await page.getByLabel("Server address or sign-in link").fill(`${origin}/#connect=${state.accessCode}`);
  await screenshot("pairing");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("The remote connection is ready.", { exact: false })).toBeVisible();
  await screenshot("conversation-light");
  for (const [width, height] of [[320, 640], [390, 844], [430, 932], [768, 1024], [844, 390], [390, 420]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const composer = await page.getByRole("combobox", { name: "Message" }).boundingBox();
    assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= width && composer.y + composer.height <= height);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/drawer-open/); await screenshot("sessions");
  await page.locator(".drawer-backdrop").click({ position: { x: 375, y: 200 } });
  await page.getByRole("button", { name: "Open tasks", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No active work", exact: true })).toBeVisible(); await screenshot("activity");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByText("README.md", { exact: true })).toBeVisible();
  await page.locator(".drawer-backdrop").click({ position: { x: 5, y: 200 } });
  await page.locator("input[type=file]").setInputFiles({ name: "mobile-note.txt", mimeType: "text/plain", buffer: Buffer.from("Attachment from the phone") });
  await expect.poll(async () => (await readdir(join(workspace, "uploads/web")).catch(() => [])).length).toBe(1);
  const attachment = (await readdir(join(workspace, "uploads/web")))[0];
  assert.equal(await readFile(join(workspace, "uploads/web", attachment), "utf8"), "Attachment from the phone");
  const input = page.getByRole("combobox", { name: "Message" });
  await input.fill("Run a remote task"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Working on your remote task.", { exact: true })).toBeVisible();
  await input.fill("Then review the result"); await page.getByRole("button", { name: "Send queued message", exact: true }).click();
  await expect.poll(() => requests.some((r) => r.method === "rind/session/follow_up")).toBe(true);
  await page.getByRole("button", { name: "Stop active turn", exact: true }).click();
  await expect.poll(() => requests.some((r) => r.method === "session/cancel")).toBe(true);
  await input.fill("Unsent draft stays on this screen");
  for (const ws of sockets) ws.terminate();
  await expect.poll(() => requests.filter((r) => r.method === "session/replay").length).toBeGreaterThan(1);
  await expect(input).toHaveValue("Unsent draft stays on this screen");
  assert.equal(requests.filter((r) => r.method === "session/prompt").length, 1, "reconnection never resends a prompt");
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator(".drawer-backdrop").click({ position: { x: 375, y: 200 } });
  await screenshot("conversation-dark");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByText("Development computer", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to light theme", exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!storage.includes(state.accessCode), "access code must never enter WebView storage");
  await page.getByRole("button", { name: "Forget Development computer", exact: true }).click();
  await page.getByRole("button", { name: "Forget computer", exact: true }).click();
  await expect(page.getByText("Bring your computer along", { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("PASS: pairing, authenticated gateway, replay, six viewports including landscape/reduced height, drawers, files/upload, prompt/queue/stop, reconnect with draft, credential isolation and forget.");
} finally {
  endTurn?.(); for (const ws of sockets) ws.terminate();
  await browser?.close(); await gateway.stop();
  await new Promise((done) => { if (server) server.httpServer.close(done); else done(); });
  await rm(root, { recursive: true, force: true });
}
