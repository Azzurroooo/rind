// Focus helpers shared by dialogs and drawers: tabbable lookup and a Tab-cycle handler.
const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function tabbables(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(TABBABLE)).filter(
    (node) => !node.closest("[inert]") && node.getAttribute("aria-hidden") !== "true",
  );
}

export function focusFirst(root, preferred) {
  const target = preferred || root?.querySelector("[data-autofocus]") || tabbables(root)[0] || root;
  target?.focus?.();
  return target;
}

// Keep Tab / Shift+Tab inside root. Returns true when the event was handled.
export function trapTab(event, root) {
  if (event.key !== "Tab" || !root) return false;
  const nodes = tabbables(root);
  if (nodes.length === 0) {
    event.preventDefault();
    root.focus?.();
    return true;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const current = document.activeElement;
  if (event.shiftKey && (current === first || !root.contains(current))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (current === last || !root.contains(current))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
