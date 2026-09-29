// Pure rules for toasts and tooltips (spec section 7), kept DOM-free for tests.

export const TOAST_LIMIT = 3
export const TOAST_DURATION_MS = 4000
export const TOOLTIP_DELAY_MS = 400

export type ToastTone = "info" | "success" | "danger"
export type Toast = { id: number; message: string; tone: ToastTone }

/** Adds a toast, dropping the oldest beyond the limit and collapsing repeats. */
export function pushToast(list: readonly Toast[], toast: Toast, limit = TOAST_LIMIT): Toast[] {
  const others = list.filter((item) => item.message !== toast.message || item.tone !== toast.tone)
  return [...others, toast].slice(-limit)
}

export function dropToast(list: readonly Toast[], id: number): Toast[] {
  return list.filter((item) => item.id !== id)
}

export type Rect = { top: number; left: number; width: number; height: number }
export type Viewport = { width: number; height: number }

const GAP = 6
const MARGIN = 8

/**
 * Places a tooltip below its target, or above when there is no room, centred
 * horizontally and clamped inside the viewport.
 */
export function tooltipPosition(target: Rect, tip: { width: number; height: number }, viewport: Viewport) {
  const below = target.top + target.height + GAP
  const fitsBelow = below + tip.height + MARGIN <= viewport.height
  const top = fitsBelow ? below : Math.max(MARGIN, target.top - GAP - tip.height)
  const centred = target.left + target.width / 2 - tip.width / 2
  const left = Math.min(Math.max(MARGIN, centred), Math.max(MARGIN, viewport.width - tip.width - MARGIN))
  return { top: Math.round(top), left: Math.round(left), placement: fitsBelow ? "below" as const : "above" as const }
}
