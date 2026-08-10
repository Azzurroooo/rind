import "./style.css"

import type { RuntimeSnapshot } from "../preload/types"

const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Renderer root is missing.")
const app = root

function render(snapshot: RuntimeSnapshot) {
  const message = snapshot.message ? `<p class="message">${escapeHtml(snapshot.message)}</p>` : ""
  app.innerHTML = `
    <section class="shell" aria-live="polite">
      <div class="brand">Rind</div>
      <h1>Desktop shell</h1>
      <p class="status status-${snapshot.status}">${snapshot.status}</p>
      ${message}
      <button id="pick-directory" type="button">Choose workspace</button>
    </section>
  `
  document.querySelector<HTMLButtonElement>("#pick-directory")?.addEventListener("click", async () => {
    const directory = await window.api.openDirectory()
    if (directory) app.dataset.workspace = directory
  })
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character)
}

const unsubscribe = window.api.runtime.subscribe(render)
window.addEventListener("beforeunload", unsubscribe, { once: true })
void window.api.runtime.initialize().catch((error: unknown) => {
  render({ status: "error", message: error instanceof Error ? error.message : String(error) })
})
