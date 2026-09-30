import type { SegmentOpenMode } from "./work-segments.ts"

/** Let a completed live fold settle once, instead of reacting to every RPC. */
export class SegmentPresentation {
  private folds = new Map<string, { mode: SegmentOpenMode; closeAt: number | null }>()

  mode(id: string, desired: SegmentOpenMode, manual: boolean, now: number): SegmentOpenMode {
    const previous = this.folds.get(id)
    if (desired !== "closed" || manual || !previous || previous.mode === "closed") {
      this.folds.set(id, { mode: desired, closeAt: null })
      return desired
    }
    const closeAt = previous.closeAt ?? now + 600
    const mode = now >= closeAt ? "closed" : previous.mode
    this.folds.set(id, { mode, closeAt: mode === "closed" ? null : closeAt })
    return mode
  }

  prune(ids: Set<string>) {
    for (const id of this.folds.keys()) if (!ids.has(id)) this.folds.delete(id)
  }

  deadline(): number | null {
    const times = [...this.folds.values()].flatMap((fold) => fold.closeAt === null ? [] : [fold.closeAt])
    return times.length ? Math.min(...times) : null
  }
}

/** Preserve fold shells, keyed tool rows, focus and scroll during streaming.
 * Only tool markup uses this reconciler; user inputs and message prose don't.
 */
export function reconcileToolElement(current: Element, next: Element) {
  if (current.isEqualNode(next)) return
  for (const attr of Array.from(current.attributes)) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name)
  for (const attr of Array.from(next.attributes)) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value)
  // Keep the last visible rows while the shell animates shut. They are inert
  // and refreshed on reopening; no heavy hidden tool output is regenerated.
  if (current.classList.contains("segment-calls-clip") && next.parentElement?.getAttribute("aria-hidden") === "true") return
  const key = (node: Node) => node instanceof Element ? node.getAttribute("data-tool-id") || node.id : ""
  const old = Array.from(current.childNodes)
  const keyed = new Map(old.filter(key).map((node) => [key(node), node]))
  const used = new Set<Node>()
  const nodes = Array.from(next.childNodes).map((node, index) => {
    const id = key(node)
    const match = id ? keyed.get(id) : old[index]
    if (!match || used.has(match) || key(match) !== id || match.nodeType !== node.nodeType || match.nodeName !== node.nodeName) return node
    used.add(match)
    if (match instanceof Element && node instanceof Element) reconcileToolElement(match, node)
    else if (match.textContent !== node.textContent) match.textContent = node.textContent
    return match
  })
  const keep = new Set(nodes)
  for (const child of old) if (!keep.has(child)) child.remove()
  let anchor = current.firstChild
  for (const node of nodes) {
    if (node !== anchor) current.insertBefore(node, anchor)
    anchor = node.nextSibling
  }
}
