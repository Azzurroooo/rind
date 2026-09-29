// Toasts and tooltips (spec section 7). One delegated tooltip for every
// [data-tooltip] element, and a polite live region for toasts.

import { dropToast, pushToast, TOAST_DURATION_MS, TOOLTIP_DELAY_MS, tooltipPosition, type Toast, type ToastTone } from "../overlay-model.ts"

let toasts: Toast[] = []
let nextToastId = 1
let toastRegion: HTMLElement | undefined
let tooltip: HTMLElement | undefined
let tooltipTarget: HTMLElement | undefined
let tooltipTimer: number | undefined

export function showToast(message: string, tone: ToastTone = "info") {
  const text = message.trim()
  if (!text) return
  const id = nextToastId++
  toasts = pushToast(toasts, { id, message: text, tone })
  renderToasts()
  window.setTimeout(() => {
    toasts = dropToast(toasts, id)
    renderToasts()
  }, TOAST_DURATION_MS)
}

function renderToasts() {
  const region = ensureToastRegion()
  const kept = new Set(toasts.map((toast) => String(toast.id)))
  for (const node of [...region.children] as HTMLElement[]) {
    if (!kept.has(node.dataset.toastId || "")) node.remove()
  }
  for (const toast of toasts) {
    if (region.querySelector(`[data-toast-id="${toast.id}"]`)) continue
    const node = document.createElement("div")
    node.className = `toast toast-${toast.tone}`
    node.dataset.toastId = String(toast.id)
    node.textContent = toast.message
    region.append(node)
  }
}

function ensureToastRegion() {
  if (toastRegion?.isConnected) return toastRegion
  const region = document.createElement("div")
  region.className = "toast-region"
  region.setAttribute("role", "status")
  region.setAttribute("aria-live", "polite")
  document.body.append(region)
  toastRegion = region
  return region
}

function ensureTooltip() {
  if (tooltip?.isConnected) return tooltip
  const node = document.createElement("div")
  node.className = "tooltip"
  node.id = "app-tooltip"
  node.setAttribute("role", "tooltip")
  node.hidden = true
  document.body.append(node)
  tooltip = node
  return node
}

function tooltipOwner(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") || undefined : undefined
}

function scheduleTooltip(target: HTMLElement, delay: number) {
  if (tooltipTarget === target) return
  hideTooltip()
  tooltipTarget = target
  tooltipTimer = window.setTimeout(() => showTooltip(target), delay)
}

function showTooltip(target: HTMLElement) {
  const text = target.dataset.tooltip?.trim()
  if (!text || !target.isConnected || (target as HTMLButtonElement).disabled) return
  const node = ensureTooltip()
  node.textContent = text
  node.hidden = false
  const rect = target.getBoundingClientRect()
  const place = tooltipPosition(rect, { width: node.offsetWidth, height: node.offsetHeight }, { width: window.innerWidth, height: window.innerHeight })
  node.style.top = `${place.top}px`
  node.style.left = `${place.left}px`
  node.dataset.placement = place.placement
  // Icon buttons already carry an aria-label; only describe when it adds text.
  if (target.getAttribute("aria-label") !== text) target.setAttribute("aria-describedby", node.id)
}

export function hideTooltip() {
  if (tooltipTimer !== undefined) window.clearTimeout(tooltipTimer)
  tooltipTimer = undefined
  if (tooltipTarget?.getAttribute("aria-describedby") === "app-tooltip") tooltipTarget.removeAttribute("aria-describedby")
  tooltipTarget = undefined
  if (tooltip) tooltip.hidden = true
}

export function bindOverlays(): void {
  document.addEventListener("pointerover", (event) => {
    const owner = tooltipOwner(event.target)
    if (owner) scheduleTooltip(owner, TOOLTIP_DELAY_MS)
    else if (tooltipTarget) hideTooltip()
  })
  document.addEventListener("focusin", (event) => {
    const owner = tooltipOwner(event.target)
    if (owner && owner.matches(":focus-visible")) scheduleTooltip(owner, TOOLTIP_DELAY_MS)
  })
  document.addEventListener("focusout", hideTooltip)
  document.addEventListener("pointerdown", hideTooltip, true)
  document.addEventListener("scroll", hideTooltip, true)
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTooltip() })
  window.addEventListener("blur", hideTooltip)
}
