// Keyboard behaviour shared by popover menus (spec section 7): arrows move
// between enabled items, Home and End jump, Tab closes without trapping.

function menuItems(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")]
    .filter((item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true")
}

export function focusFirstMenuItem(menu: HTMLElement | null) {
  if (menu) menuItems(menu)[0]?.focus()
}

/** Returns "close" when the menu should close, "handled" for navigation, or undefined. */
export function handleMenuKeydown(event: KeyboardEvent, menu: HTMLElement): "close" | "handled" | undefined {
  if (event.key === "Tab") return "close"
  const items = menuItems(menu)
  if (!items.length) return undefined
  const index = items.indexOf(document.activeElement as HTMLElement)
  const target = event.key === "ArrowDown" ? items[(index + 1) % items.length]
    : event.key === "ArrowUp" ? items[(index - 1 + items.length) % items.length]
      : event.key === "Home" ? items[0]
        : event.key === "End" ? items[items.length - 1]
          : undefined
  if (!target) return undefined
  event.preventDefault()
  target.focus()
  return "handled"
}
