/** Patch a small keyed view without replacing focused controls or scroll containers. */
export function patchChildren(target: Element, html: string) {
  const template = target.ownerDocument.createElement("template")
  template.innerHTML = html
  syncChildren(target, template.content)
}

function key(node: Node): string | null {
  return node.nodeType === 1 ? (node as Element).getAttribute("data-key") || (node as Element).id || null : null
}

function compatible(left: Node, right: Node) {
  return left.nodeType === right.nodeType && left.nodeName === right.nodeName && key(left) === key(right)
}

function syncChildren(current: Node, next: Node) {
  const keyed = new Map(Array.from(current.childNodes).filter(key).map((node) => [key(node), node]))
  let anchor = current.firstChild
  for (const desired of Array.from(next.childNodes)) {
    const candidate = key(desired) ? keyed.get(key(desired)) : anchor
    const node = candidate && compatible(candidate, desired) ? candidate : desired.cloneNode(true)
    if (node !== anchor) current.insertBefore(node, anchor)
    if (!node.isEqualNode(desired)) {
      if (node.nodeType === 1) {
        const element = node as Element, source = desired as Element
        for (const attr of Array.from(element.attributes)) if (!source.hasAttribute(attr.name)) element.removeAttribute(attr.name)
        for (const attr of Array.from(source.attributes)) if (element.getAttribute(attr.name) !== attr.value) element.setAttribute(attr.name, attr.value)
        syncChildren(element, source)
      } else if (node.nodeValue !== desired.nodeValue) node.nodeValue = desired.nodeValue
    }
    anchor = node.nextSibling
  }
  while (anchor) { const next = anchor.nextSibling; current.removeChild(anchor); anchor = next }
}
