import { Capacitor, CapacitorHttp, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { conversationMarkdown, exportConversation } from "@surface/lib/sessionPreferences.js";
import { createHostStore } from "./hostStore.js";
import { parsePairing } from "./pairing.js";

export const isNative = Capacitor.isNativePlatform();
// Never invoke the secure-storage plugin's unencrypted browser implementation.
export const hostStore = createHostStore(Preferences, isNative ? {
  get: (key) => SecureStorage.get(key, false, false),
  set: (key, value) => SecureStorage.set(key, value, false, false),
  remove: (key) => SecureStorage.remove(key, false),
} : {
  get: async () => null,
  set: async () => { throw new Error("Secure credential storage requires the installed app."); },
  remove: async () => {},
});

export async function ticketFetch(endpoint, options) {
  const url = new URL(endpoint);
  const pairing = parsePairing(url.origin);
  if (url.href !== `${pairing.origin}/ticket`) throw new Error("Invalid ticket endpoint.");
  if (!isNative) return fetch(endpoint, { ...options, redirect: "error", signal: AbortSignal.timeout(12000) });
  const response = await CapacitorHttp.request({
    url: endpoint, method: "GET", headers: options.headers,
    connectTimeout: 12000, readTimeout: 12000, disableRedirects: true, responseType: "json",
  });
  return { ok: response.status === 200, status: response.status, json: async () => response.data };
}

export async function scanPairing() {
  if (!isNative) throw new Error("QR scanning is available in the installed app. Paste a sign-in link here.");
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import("@capacitor/barcode-scanner");
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: "Scan Rind Desktop → Remote access", scanButton: false });
    return result.ScanResult || "";
  } catch (error) {
    if (error.code === "OS-PLUG-BARC-0006") return "";
    throw error;
  }
}

// Asynchronous Capacitor listener registration must also clean up after early unmount.
export function listen(register) {
  let disposed = false;
  let handle;
  register().then((result) => { if (disposed) void result.remove(); else handle = result; }).catch(() => {});
  return () => { disposed = true; if (handle) void handle.remove(); };
}

export function subscribeLifecycle(callback) {
  let active = true;
  let online = true;
  let disposed = false;
  let appRevision = 0, networkRevision = 0;
  const publish = () => { if (!disposed) callback(active && online); };
  const cleanups = [
    listen(() => App.addListener("appStateChange", (state) => { ++appRevision; active = state.isActive; publish(); })),
    listen(() => Network.addListener("networkStatusChange", (state) => { ++networkRevision; online = state.connected; publish(); })),
  ];
  App.getState().then((state) => { if (!appRevision) { active = state.isActive; publish(); } }).catch(() => {});
  Network.getStatus().then((state) => { if (!networkRevision) { online = state.connected; publish(); } }).catch(() => {});
  return () => { disposed = true; cleanups.forEach((cleanup) => cleanup()); };
}

export async function shareConversation(messages, title) {
  if (!isNative) return exportConversation(messages, title);
  const previous = await Filesystem.readdir({ path: "rind-exports", directory: Directory.Cache }).catch(() => ({ files: [] }));
  for (const file of previous.files) if (/^rind-\d+\.md$/.test(file.name) && Number(file.mtime) < Date.now() - 86400000) {
    await Filesystem.deleteFile({ path: `rind-exports/${file.name}`, directory: Directory.Cache }).catch(() => {});
  }
  const path = `rind-exports/rind-${Date.now()}.md`;
  const file = await Filesystem.writeFile({ path, data: conversationMarkdown(messages, title), directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
  // The receiving app may still be reading after the chooser closes. Expire later.
  await Share.share({ title, files: [file.uri], dialogTitle: "Share conversation" });
}

export function installNativeUI({ onLink, onBack }) {
  if (!isNative) return () => {};
  let disposed = false;
  const cleanups = [
    listen(() => App.addListener("appUrlOpen", ({ url }) => onLink(url))),
    listen(() => App.addListener("backButton", () => {
      const modal = [...document.querySelectorAll("[aria-modal='true'], [role='menu']")].at(-1);
      if (modal) { modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return; }
      const drawer = document.querySelector(".drawer-open");
      if (drawer) { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return; }
      if (document.activeElement?.matches("textarea, input")) { document.activeElement.blur(); return; }
      if (!onBack()) void App.minimizeApp();
    })),
  ];
  App.getLaunchUrl().then((result) => { if (!disposed && result?.url) onLink(result.url); }).catch(() => {});
  const openLink = (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin === window.location.origin) return;
    event.preventDefault();
    if (["https:", "http:"].includes(url.protocol)) void Browser.open({ url: url.href }).catch(() => {});
  };
  document.addEventListener("click", openLink);
  const status = () => {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
  };
  const observer = new MutationObserver(status);
  const appearance = matchMedia("(prefers-color-scheme: dark)");
  appearance.addEventListener("change", status);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  status();
  return () => { disposed = true; cleanups.forEach((cleanup) => cleanup()); observer.disconnect(); appearance.removeEventListener("change", status); document.removeEventListener("click", openLink); };
}
