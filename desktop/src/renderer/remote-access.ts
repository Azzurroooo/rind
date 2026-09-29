import type { GatewayState } from "../preload/types"
import QRCode from "qrcode"

export function remoteAccessMarkup() {
  return `<dialog id="remote-dialog" class="settings-dialog remote-dialog" aria-labelledby="remote-title">
    <div class="settings-heading"><div><h2 id="remote-title">Remote access</h2><p class="subtle">Continue from your phone or another browser.</p></div><button type="button" class="ghost-button" id="remote-close" aria-label="Close remote access">Close</button></div>
    <div class="remote-status"><span id="remote-indicator" class="status-pip"></span><strong id="remote-status">Off</strong><span id="remote-clients" class="subtle"></span></div>
    <div id="remote-setup">
      <label>Connect from<select id="remote-scope"><option value="lan">Local network — phone or another computer</option><option value="loopback">This computer — private HTTPS proxy / VPN</option></select></label>
      <details class="remote-advanced"><summary>Advanced connection</summary><label>Port<input id="remote-port" type="number" min="1024" max="65535" value="8766" /></label><label>Existing HTTPS address (optional)<input id="remote-origin" type="url" placeholder="https://your-computer.example" /></label><p class="subtle">Use an HTTPS proxy you have already configured to forward to this computer’s port. Rind does not create a public tunnel.</p></details>
      <p class="remote-explanation">Anyone with the access code can use your Rind sessions, files and agent tools. Use a trusted network; use HTTPS or a private VPN outside it. Keep Rind running on this computer.</p>
    </div>
    <div id="remote-sharing" hidden>
      <div class="remote-qr-row"><img id="remote-qr" width="160" height="160" alt="QR code for signing in to Rind" /><div><strong id="remote-connect-title">Scan to connect</strong><p id="remote-connect-hint" class="subtle">Use your phone’s camera on the same Wi-Fi network.</p><button type="button" id="remote-copy-link" class="ghost-button">Copy sign-in link</button></div></div>
      <details class="remote-advanced"><summary>Connect manually or choose another address</summary>
      <label for="remote-address">1. Open this address on your other device</label><div class="remote-copy-row"><select id="remote-address"></select><button type="button" id="remote-copy-address" class="ghost-button">Copy</button></div>
      <label for="remote-code">2. Enter the access code</label><div class="remote-copy-row"><input id="remote-code" type="password" readonly autocomplete="off" /><button type="button" id="remote-reveal" class="ghost-button" aria-label="Show access code">Show</button><button type="button" id="remote-copy-code" class="ghost-button">Copy</button></div>
      </details>
      <p class="subtle">Keep the QR code, sign-in link and access code private: they grant access to your sessions, files and agent tools. Closing a browser leaves tasks running. Closing Rind ends remote access.</p>
      <button type="button" id="remote-rotate" class="ghost-button">Generate new code & disconnect devices</button>
    </div>
    <p id="remote-message" class="remote-message" role="status"></p>
    <div class="settings-actions"><button type="button" id="remote-toggle" class="primary-button">Enable remote access</button></div>
  </dialog>`
}

export function bindRemoteAccess() {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const dialog = element<HTMLDialogElement>("remote-dialog")
  const toggle = element<HTMLButtonElement>("remote-toggle")
  const message = element<HTMLElement>("remote-message")
  const code = element<HTMLInputElement>("remote-code")
  const addresses = element<HTMLSelectElement>("remote-address")
  let state: GatewayState | undefined
  let busy = false
  let qrValue = ""
  const signInLink = () => `${addresses.value}/#connect=${encodeURIComponent(code.value)}`
  async function updateQr() {
    const value = state?.running && addresses.value && code.value ? signInLink() : ""
    if (value === qrValue) return
    qrValue = value
    const target = element<HTMLImageElement>("remote-qr")
    target.removeAttribute("src")
    if (!value) return
    const localOnly = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(addresses.value).hostname)
    target.hidden = localOnly
    element("remote-connect-title").textContent = localOnly ? "Open in your browser" : "Scan to connect"
    element("remote-connect-hint").textContent = localOnly
      ? "This address works on this computer only. Choose a local-network or HTTPS address to connect another device."
      : addresses.value.startsWith("https:") ? "Use your phone’s camera to open your private HTTPS address." : "Use your phone’s camera on the same Wi-Fi network."
    if (localOnly) return
    try {
      const data = await QRCode.toDataURL(value, { width: 192, margin: 2, errorCorrectionLevel: "M" })
      if (qrValue === value) target.src = data
    } catch { message.textContent = "QR unavailable. Copy the address and access code below." }
  }
  function render(next: GatewayState) {
    state = next
    element("remote-status").textContent = next.running ? "Remote access is on" : "Remote access is off"
    element("remote-indicator").classList.toggle("pip-running", next.running)
    element("remote-clients").textContent = next.running ? `${next.clients} connected ${next.clients === 1 ? "device" : "devices"}` : ""
    element("remote-sharing").hidden = !next.running
    element("remote-setup").hidden = next.running
    toggle.textContent = next.running ? "Turn off remote access" : "Enable remote access"
    toggle.classList.toggle("danger", next.running)
    const selected = addresses.value
    if (JSON.stringify([...addresses.options].map((item) => item.value)) !== JSON.stringify(next.addresses)) {
      addresses.replaceChildren(...next.addresses.map((address) => new Option(address, address)))
      if (next.addresses.includes(selected)) addresses.value = selected
    }
    code.value = next.accessCode
    void updateQr()
    const trigger = document.getElementById("open-remote")
    trigger?.classList.toggle("remote-active", next.running)
    trigger?.setAttribute("title", next.running ? `Remote access · ${next.clients} devices` : "Remote access")
  }
  async function action(run: () => Promise<GatewayState>, success = "") {
    if (busy) return
    busy = true; message.textContent = ""; toggle.disabled = true
    element<HTMLButtonElement>("remote-rotate").disabled = true
    try { render(await run()); message.textContent = success }
    catch (error) { message.textContent = error instanceof Error ? error.message : String(error) }
    finally { busy = false; toggle.disabled = false; element<HTMLButtonElement>("remote-rotate").disabled = false }
  }
  const open = () => { dialog.showModal(); void action(() => window.api.gateway.get()) }
  element("remote-close").addEventListener("click", () => dialog.close())
  dialog.addEventListener("close", () => { code.type = "password"; element("remote-reveal").textContent = "Show"; element("remote-reveal").setAttribute("aria-label", "Show access code"); document.getElementById("open-remote")?.focus() })
  toggle.addEventListener("click", () => void action(async () => {
    if (state?.running) return window.api.gateway.stop()
    const port = Number(element<HTMLInputElement>("remote-port").value)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a port between 1024 and 65535.")
    return window.api.gateway.start({ scope: element<HTMLSelectElement>("remote-scope").value as "lan" | "loopback", port, externalOrigin: element<HTMLInputElement>("remote-origin").value.trim() || undefined })
  }))
  element("remote-rotate").addEventListener("click", () => void action(() => window.api.gateway.rotate(), "New access code generated. Previous devices have been disconnected."))
  element("remote-reveal").addEventListener("click", () => { code.type = code.type === "password" ? "text" : "password"; element("remote-reveal").textContent = code.type === "password" ? "Show" : "Hide"; element("remote-reveal").setAttribute("aria-label", `${code.type === "password" ? "Show" : "Hide"} access code`) })
  addresses.addEventListener("change", () => void updateQr())
  for (const [id, value] of [["remote-copy-address", () => addresses.value], ["remote-copy-code", () => code.value], ["remote-copy-link", signInLink]] as const) {
    element(id).addEventListener("click", () => { void navigator.clipboard.writeText(value()).then(() => { message.textContent = id === "remote-copy-code" ? "Access code copied." : id === "remote-copy-link" ? "Sign-in link copied. Share it only with your own devices." : "Address copied." }).catch(() => { message.textContent = "Select and copy the address and access code below." }) })
  }
  const dispose = window.api.gateway.subscribe(render)
  return { open, dispose }
}
