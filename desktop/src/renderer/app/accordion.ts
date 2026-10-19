const EXPAND_EASING = "cubic-bezier(0.22, 1, 0.36, 1)"
const EXPAND_DURATION_MS = 220
const COLLAPSE_DURATION_MS = 200

function prefersReducedMotion(): boolean {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  } catch {
    return false
  }
}

export function animateExpand(element: HTMLElement | null | undefined): void {
  if (!element || prefersReducedMotion()) return
  const targetHeight = element.scrollHeight
  if (targetHeight <= 0) return

  element.style.overflow = "hidden"
  element.style.height = "0px"
  element.style.opacity = "0"
  element.style.transition = "none"
  void element.offsetHeight

  element.style.transition = `height ${EXPAND_DURATION_MS}ms ${EXPAND_EASING}, opacity 175ms ${EXPAND_EASING}`
  element.style.height = `${targetHeight}px`
  element.style.opacity = "1"

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    element.removeEventListener("transitionend", onEnd)
    element.style.height = ""
    element.style.opacity = ""
    element.style.overflow = ""
    element.style.transition = ""
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === "height") cleanup()
  }
  element.addEventListener("transitionend", onEnd)
  window.setTimeout(cleanup, EXPAND_DURATION_MS + 30)
}

export function animateCollapse(element: HTMLElement | null | undefined): Promise<void> {
  if (!element || prefersReducedMotion()) return Promise.resolve()
  const startHeight = element.scrollHeight
  if (startHeight <= 0) return Promise.resolve()

  return new Promise<void>((resolve) => {
    element.style.overflow = "hidden"
    element.style.height = `${startHeight}px`
    element.style.opacity = "1"
    element.style.transition = "none"
    void element.offsetHeight

    element.style.transition = `height ${COLLAPSE_DURATION_MS}ms ${EXPAND_EASING}, opacity 155ms ${EXPAND_EASING}`
    element.style.height = "0px"
    element.style.opacity = "0"

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      element.removeEventListener("transitionend", onEnd)
      resolve()
    }
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "height") finish()
    }
    element.addEventListener("transitionend", onEnd)
    window.setTimeout(finish, COLLAPSE_DURATION_MS + 25)
  })
}
