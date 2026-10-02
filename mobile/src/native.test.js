import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  app: { addListener: vi.fn(), getState: vi.fn(), getLaunchUrl: vi.fn(), minimizeApp: vi.fn() }, network: { addListener: vi.fn(), getStatus: vi.fn() },
  bars: { setStyle: vi.fn() },
  appearance: { setBackground: vi.fn() },
  filesystem: { readdir: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn() }, share: { share: vi.fn() },
  http: { request: vi.fn() }, scanner: vi.fn(), appListeners: {}, networkListeners: {}, removes: [],
}));
vi.mock("@capacitor/core", async (original) => ({ ...await original(), Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" }, CapacitorHttp: h.http, SystemBars: h.bars, registerPlugin: () => h.appearance }));
vi.mock("@capacitor/app", () => ({ App: h.app }));
vi.mock("@capacitor/network", () => ({ Network: h.network }));
vi.mock("@capacitor/filesystem", async (original) => ({ ...await original(), Filesystem: h.filesystem }));
vi.mock("@capacitor/share", () => ({ Share: h.share }));
vi.mock("@capacitor/barcode-scanner", () => ({ CapacitorBarcodeScanner: { scanBarcode: h.scanner }, CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 } }));
import { installNativeUI, listen, scanPairing, shareConversation, subscribeLifecycle, ticketFetch } from "./native.js";
beforeEach(() => {
  vi.clearAllMocks(); h.appListeners = {}; h.networkListeners = {}; h.removes = [];
  const register = (list) => async (event, fn) => { list[event] = fn; const remove = vi.fn(); h.removes.push(remove); return { remove }; };
  h.app.addListener.mockImplementation(register(h.appListeners));
  h.network.addListener.mockImplementation(register(h.networkListeners));
  h.app.getState.mockResolvedValue({ isActive: true }); h.network.getStatus.mockResolvedValue({ connected: true });
  h.app.getLaunchUrl.mockResolvedValue(); h.bars.setStyle.mockResolvedValue(); h.appearance.setBackground.mockResolvedValue();
  h.filesystem.readdir.mockResolvedValue({ files: [] }); h.filesystem.writeFile.mockResolvedValue({ uri: "file:///cache/rind-export.md" });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { document.body.replaceChildren(); document.documentElement.style.removeProperty("--bg"); delete document.documentElement.dataset.theme; vi.unstubAllGlobals(); });
it("treats native share cancellation as normal and still reports real sharing failures", async () => {
  const messages = [{ role: "assistant", content: "Remote reply" }];
  h.share.share.mockRejectedValueOnce(new Error("Share canceled"));
  await expect(shareConversation(messages, "Test conversation")).resolves.toBeUndefined();
  h.share.share.mockRejectedValueOnce(new Error("File permission denied"));
  await expect(shareConversation(messages, "Test conversation")).rejects.toThrow("File permission denied");
});
it("matches Android system-bar backgrounds to the Web theme after setting icon contrast", async () => {
  document.documentElement.dataset.theme = "dark"; document.documentElement.style.setProperty("--bg", "#161f19");
  const remove = installNativeUI({ onLink: vi.fn(), onBack: vi.fn() });
  try {
    await vi.waitFor(() => expect(h.appearance.setBackground).toHaveBeenCalledWith({ color: "#161f19" }));
    expect(h.bars.setStyle).toHaveBeenCalledWith({ style: "DARK" });
    expect(h.bars.setStyle.mock.invocationCallOrder[0]).toBeLessThan(h.appearance.setBackground.mock.invocationCallOrder[0]);
    document.documentElement.style.setProperty("--bg", "#f7f6f0"); document.documentElement.dataset.theme = "light";
    await vi.waitFor(() => expect(h.appearance.setBackground).toHaveBeenLastCalledWith({ color: "#f7f6f0" }));
    expect(h.bars.setStyle).toHaveBeenLastCalledWith({ style: "LIGHT" });
  } finally { remove(); }
});
it("dismisses a model listbox on Android Back without leaving the conversation", () => {
  const list = document.createElement("div"); list.setAttribute("role", "listbox"); document.body.append(list);
  const escape = vi.fn((event) => { if (event.key === "Escape") list.remove(); }); list.addEventListener("keydown", escape);
  const onBack = vi.fn(); const remove = installNativeUI({ onLink: vi.fn(), onBack });
  try {
    h.appListeners.backButton();
    expect(escape).toHaveBeenCalledOnce(); expect(list.isConnected).toBe(false);
    expect(onBack).not.toHaveBeenCalled(); expect(h.app.minimizeApp).not.toHaveBeenCalled();
  } finally { remove(); }
});
it("routes Android Back to the combobox that owns a suggestions list", () => {
  const input = document.createElement("textarea"); input.setAttribute("aria-controls", "commands");
  const list = document.createElement("div"); list.id = "commands"; list.setAttribute("role", "listbox"); document.body.append(input, list);
  input.focus();
  const escape = vi.fn((event) => { if (event.key === "Escape") list.remove(); }); input.addEventListener("keydown", escape);
  const onBack = vi.fn(); const remove = installNativeUI({ onLink: vi.fn(), onBack });
  try {
    h.appListeners.backButton();
    expect(escape).toHaveBeenCalledOnce(); expect(list.isConnected).toBe(false);
    expect(document.activeElement).toBe(input); expect(onBack).not.toHaveBeenCalled();
  } finally { remove(); }
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
