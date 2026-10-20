import { vars } from "./state.ts"

const EXPAND_EASING = "cubic-bezier(0.25, 1, 0.5, 1)"
const COLLAPSE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)"
const EXPAND_DURATION_MS = 200
const COLLAPSE_DURATION_MS = 180

function prefersReducedMotion(): boolean {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  } catch {
    return false
  }
}

function parentColumnGapPx(element: HTMLElement): number {
  const parent = element.parentElement
  if (!parent) return 0
  const style = window.getComputedStyle(parent)
  const display = style.display || ""
  const isGrid = display.includes("grid")
  const isFlexCol = display.includes("flex") && style.flexDirection.startsWith("column")
  if (!isGrid && !isFlexCol) return 0
  const gap = Number.parseFloat(style.rowGap)
  return Number.isFinite(gap) && gap > 0 ? gap : 0
}

function buildTransitionList(durationMs: number, easing: string, opacityMs: number): string {
  const props = [
    "height",
    "margin-top",
    "margin-bottom",
    "padding-top",
    "padding-bottom",
    "border-top-width",
    "border-bottom-width",
  ]
  return [
    ...props.map((prop) => `${prop} ${durationMs}ms ${easing}`),
    `opacity ${opacityMs}ms ${easing}`,
  ].join(", ")
}

function clearInlineAccordionStyles(element: HTMLElement): void {
  element.style.boxSizing = ""
  element.style.overflow = ""
  element.style.height = ""
  element.style.minHeight = ""
  element.style.marginTop = ""
  element.style.marginBottom = ""
  element.style.paddingTop = ""
  element.style.paddingBottom = ""
  element.style.borderTopWidth = ""
  element.style.borderBottomWidth = ""
  element.style.opacity = ""
  element.style.transition = ""
}

export function animateExpand(element: HTMLElement | null | undefined): void {
  if (!element || prefersReducedMotion()) return
  const rect = element.getBoundingClientRect()
  const targetHeight = rect.height || element.scrollHeight
  if (targetHeight <= 0) return

  const computed = window.getComputedStyle(element)
  const targetMarginTop = computed.marginTop
  const targetMarginBottom = computed.marginBottom
  const targetPaddingTop = computed.paddingTop
  const targetPaddingBottom = computed.paddingBottom
  const targetBorderTop = computed.borderTopWidth
  const targetBorderBottom = computed.borderBottomWidth
  const parentGap = parentColumnGapPx(element)
  const collapsedMarginTop = parentGap > 0 ? `-${parentGap}px` : "0px"

  vars.toolAnimationUntil = Math.max(vars.toolAnimationUntil, performance.now() + EXPAND_DURATION_MS + 25)

  element.style.boxSizing = "border-box"
  element.style.overflow = "hidden"
  element.style.minHeight = "0px"
  element.style.height = "0px"
  element.style.marginTop = collapsedMarginTop
  element.style.marginBottom = "0px"
  element.style.paddingTop = "0px"
  element.style.paddingBottom = "0px"
  element.style.borderTopWidth = "0px"
  element.style.borderBottomWidth = "0px"
  element.style.opacity = "0"
  element.style.transition = "none"
  void element.offsetHeight

  element.style.transition = buildTransitionList(EXPAND_DURATION_MS, EXPAND_EASING, 150)
  element.style.height = `${targetHeight}px`
  element.style.marginTop = targetMarginTop
  element.style.marginBottom = targetMarginBottom
  element.style.paddingTop = targetPaddingTop
  element.style.paddingBottom = targetPaddingBottom
  element.style.borderTopWidth = targetBorderTop
  element.style.borderBottomWidth = targetBorderBottom
  element.style.opacity = "1"

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    element.removeEventListener("transitionend", onEnd)
    clearInlineAccordionStyles(element)
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === "height") cleanup()
  }
  element.addEventListener("transitionend", onEnd)
  window.setTimeout(cleanup, EXPAND_DURATION_MS + 30)
}

export function animateCollapse(element: HTMLElement | null | undefined): Promise<void> {
  if (!element || prefersReducedMotion()) return Promise.resolve()
  const rect = element.getBoundingClientRect()
  const startHeight = rect.height || element.scrollHeight
  if (startHeight <= 0) return Promise.resolve()

  const computed = window.getComputedStyle(element)
  const startMarginTop = computed.marginTop
  const startMarginBottom = computed.marginBottom
  const startPaddingTop = computed.paddingTop
  const startPaddingBottom = computed.paddingBottom
  const startBorderTop = computed.borderTopWidth
  const startBorderBottom = computed.borderBottomWidth
  const parentGap = parentColumnGapPx(element)
  const collapsedMarginTop = parentGap > 0 ? `-${parentGap}px` : "0px"

  vars.toolAnimationUntil = Math.max(vars.toolAnimationUntil, performance.now() + COLLAPSE_DURATION_MS + 25)

  return new Promise<void>((resolve) => {
    element.style.boxSizing = "border-box"
    element.style.overflow = "hidden"
    element.style.minHeight = "0px"
    element.style.height = `${startHeight}px`
    element.style.marginTop = startMarginTop
    element.style.marginBottom = startMarginBottom
    element.style.paddingTop = startPaddingTop
    element.style.paddingBottom = startPaddingBottom
    element.style.borderTopWidth = startBorderTop
    element.style.borderBottomWidth = startBorderBottom
    element.style.opacity = "1"
    element.style.transition = "none"
    void element.offsetHeight

    element.style.transition = buildTransitionList(COLLAPSE_DURATION_MS, COLLAPSE_EASING, 140)
    element.style.height = "0px"
    element.style.marginTop = collapsedMarginTop
    element.style.marginBottom = "0px"
    element.style.paddingTop = "0px"
    element.style.paddingBottom = "0px"
    element.style.borderTopWidth = "0px"
    element.style.borderBottomWidth = "0px"
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
