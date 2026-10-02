import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  app: { addListener: vi.fn(), getState: vi.fn() }, network: { addListener: vi.fn(), getStatus: vi.fn() },
  http: { request: vi.fn() }, scanner: vi.fn(), appListeners: {}, networkListeners: {}, removes: [],
}));
vi.mock("@capacitor/core", async (original) => ({ ...await original(), Capacitor: { isNativePlatform: () => true }, CapacitorHttp: h.http }));
vi.mock("@capacitor/app", () => ({ App: h.app }));
vi.mock("@capacitor/network", () => ({ Network: h.network }));
vi.mock("@capacitor/barcode-scanner", () => ({ CapacitorBarcodeScanner: { scanBarcode: h.scanner }, CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 } }));
import { listen, scanPairing, subscribeLifecycle, ticketFetch } from "./native.js";
beforeEach(() => {
  vi.clearAllMocks(); h.appListeners = {}; h.networkListeners = {}; h.removes = [];
  const register = (list) => async (event, fn) => { list[event] = fn; const remove = vi.fn(); h.removes.push(remove); return { remove }; };
  h.app.addListener.mockImplementation(register(h.appListeners));
  h.network.addListener.mockImplementation(register(h.networkListeners));
  h.app.getState.mockResolvedValue({ isActive: true }); h.network.getStatus.mockResolvedValue({ connected: true });
});
it("combines foreground and network state, ignoring a stale initial response", async () => {
  let initial; h.app.getState.mockImplementation(() => new Promise((resolve) => { initial = resolve; }));
  const states = []; const remove = subscribeLifecycle((state) => states.push(state));
  h.appListeners.appStateChange({ isActive: false }); initial({ isActive: true });
  await Promise.resolve(); await Promise.resolve();
  expect(states.at(-1)).toBe(false);
  h.networkListeners.networkStatusChange({ connected: false });
  h.appListeners.appStateChange({ isActive: true }); expect(states.at(-1)).toBe(false);
  h.networkListeners.networkStatusChange({ connected: true }); expect(states.at(-1)).toBe(true);
  remove(); const count = states.length;
  h.appListeners.appStateChange({ isActive: false }); expect(states).toHaveLength(count);
  expect(h.removes.every((fn) => fn.mock.calls.length === 1)).toBe(true);
});
it("removes listeners even when the component unmounts during native registration", async () => {
  let resolve; const remove = vi.fn(); const dispose = listen(() => new Promise((done) => { resolve = done; }));
  dispose(); resolve({ remove }); await Promise.resolve(); expect(remove).toHaveBeenCalledOnce();
});
it("treats scanner cancellation as a normal return and preserves permission failures", async () => {
  h.scanner.mockRejectedValueOnce({ code: "OS-PLUG-BARC-0006" });
  expect(await scanPairing()).toBe("");
  h.scanner.mockRejectedValueOnce({ code: "OS-PLUG-BARC-0007" });
  await expect(scanPairing()).rejects.toEqual({ code: "OS-PLUG-BARC-0007" });
});
it("uses a bounded native ticket exchange without redirects or credential query strings", async () => {
  h.http.request.mockResolvedValue({ status: 200, data: { ticket: "one" } });
  const response = await ticketFetch("http://192.168.0.2:8766/ticket", { headers: { Authorization: "Bearer code" } });
  expect(await response.json()).toEqual({ ticket: "one" });
  expect(h.http.request).toHaveBeenCalledWith(expect.objectContaining({ disableRedirects: true, readTimeout: 12000, connectTimeout: 12000, url: "http://192.168.0.2:8766/ticket" }));
  await expect(ticketFetch("https://work.test/ticket?token=code", {})).rejects.toThrow("Invalid ticket");
  await expect(ticketFetch("http://public.test/ticket", {})).rejects.toThrow("HTTPS");
});
