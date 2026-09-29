import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeClient, initialRuntimeUrl } from "./runtimeClient.js";
import { consumePairingCode, dropCredentials, hasStoredCredential, readStoredToken, storeToken } from "./ticket.js";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) { super(); this.url = url; Socket.instances.push(this); }
  send(value) { if (this.readyState !== 1) throw new Error("closed"); this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close(code = 1000) { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code })); }
  reply(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
}
const tick = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
let clients;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket); Socket.instances = []; clients = []; });
afterEach(() => { clients.forEach((client) => client.disconnect()); vi.useRealTimers(); vi.unstubAllGlobals(); dropCredentials(); });
function client(options = {}) {
  const value = createRuntimeClient({ url: "ws://rind.test/ws", ...options }); clients.push(value); return value;
}
async function open(value) { const pending = value.connect(); await tick(); Socket.instances.at(-1).open(); await pending; await tick(); return Socket.instances.at(-1); }

describe("runtime connection lifecycle", () => {
  it("does not open a socket when a cancelled ticket exchange completes", async () => {
    let resolveTicket;
    const value = client({ credentialProvider: () => new Promise((resolve) => { resolveTicket = resolve; }) });
    const pending = value.connect().catch((error) => error);
    await tick(); value.disconnect(); resolveTicket("ticket=late"); await tick();
    expect((await pending).message).toMatch(/cancelled/);
    expect(Socket.instances).toHaveLength(0);
  });

  it("invalidates delayed credentials on timeout and retries with a fresh exchange", async () => {
    let resolveTicket;
    const credentialProvider = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveTicket = resolve; })).mockResolvedValue("ticket=fresh");
    const value = client({ credentialProvider });
    const pending = value.connect().catch((error) => error);
    await tick(); await vi.advanceTimersByTimeAsync(12000);
    expect((await pending).message).toMatch(/timed out/);
    resolveTicket("ticket=expired"); await tick(); expect(Socket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(Socket.instances[0].url).toContain("ticket=fresh");
    Socket.instances[0].open(); await tick();
  });

  it("rejects pending requests on disconnect and ignores events from an old socket", async () => {
    const onEvent = vi.fn(); const value = client({ onEvent });
    const old = await open(value);
    const pending = value.request("session/list").catch((error) => error); await tick();
    value.disconnect(); expect((await pending).message).toMatch(/closed/);
    const current = await open(value);
    old.reply({ kind: "event", event: { type: "turn_completed" } }); old.close();
    expect(value.connected).toBe(true); expect(onEvent).not.toHaveBeenCalled();
    current.reply({ kind: "event", event: { type: "turn_started" } }); expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after access is revoked", async () => {
    const onStatus = vi.fn(); const value = client({ onStatus }); const socket = await open(value);
    socket.close(4401); await vi.advanceTimersByTimeAsync(60000);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "unauthorized" }));
    expect(Socket.instances).toHaveLength(1);
  });

  it("switching the address closes the old socket without sending old credentials", async () => {
    const credentialProvider = vi.fn(async (url) => url.includes("rind.test") ? "ticket=first" : "ticket=second");
    const value = client({ credentialProvider }); await open(value);
    value.setUrl("ws://other.test/ws"); await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.instances).toHaveLength(1);
    await open(value); expect(Socket.instances[1].url).toBe("ws://other.test/ws?ticket=second");
    expect(() => value.setUrl("http://other.test")).toThrow(/Invalid/);
  });

  it("times out individual requests and reconnects silently dropped sockets", async () => {
    const value = client(); const socket = await open(value);
    const pending = value.request("session/list", {}, 100).catch((error) => error); await tick();
    await vi.advanceTimersByTimeAsync(100); expect((await pending).message).toMatch(/timed out/);
    await vi.advanceTimersByTimeAsync(30000); expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(500); expect(Socket.instances).toHaveLength(2);
  });

  it("handles socket errors and initialization failures without getting stuck", async () => {
    const value = client({ onOpen: async () => { throw new Error("initialize failed"); } });
    const pending = value.connect().catch((error) => error); await tick();
    Socket.instances[0].dispatchEvent(new Event("error")); await pending;
    await vi.advanceTimersByTimeAsync(500); Socket.instances[1].open(); await tick();
    expect(value.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(500); expect(Socket.instances).toHaveLength(3);
  });
});

it("credentials are scoped to one exact server and cleared on logout", () => {
  storeToken("private-code", "ws://desktop.test/ws");
  expect(readStoredToken("ws://desktop.test/ws")).toBe("private-code");
  expect(readStoredToken("ws://other.test/ws")).toBe("");
  expect(hasStoredCredential("ws://other.test/ws")).toBe(false);
  dropCredentials(); expect(hasStoredCredential("ws://desktop.test/ws")).toBe(false);
});

it("ignores legacy address preferences and query overrides when pairing", () => {
  history.replaceState(null, "", "/?ws=wss://other.test/ws");
  localStorage.setItem("rind.wsUrl", "wss://old.test/ws");
  try {
    expect(initialRuntimeUrl()).toBe(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  } finally {
    history.replaceState(null, "", "/");
    localStorage.removeItem("rind.wsUrl");
  }
});

it("consumes a pairing fragment before connecting and leaves no access code in the address", () => {
  const code = "abcdefghijklmnopqrstuvwxyz123456";
  history.replaceState(null, "", `/#connect=${code}`);
  expect(consumePairingCode()).toBe(code);
  expect(location.hash).toBe("");
  expect(consumePairingCode()).toBe("");
  history.replaceState(null, "", "/#connect=invalid");
  expect(consumePairingCode()).toBe("");
  expect(location.hash).toBe("");
});
