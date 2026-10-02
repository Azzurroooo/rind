/** Shared keyboard and focus behavior for native composer popovers. */
export function bindMenuNavigation(trigger: HTMLButtonElement, menu: HTMLElement, close: () => void) {
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled), [role=menuitem]:not(:disabled)")]
  const focusSelected = () => {
    const search = menu.querySelector<HTMLInputElement>("input[type=search]")
    const options = items()
    ;(search || options.find((item) => item.getAttribute("aria-selected") === "true") || options[0])?.focus()
  }
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    if (menu.hidden) trigger.click()
    focusSelected()
  })
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      close()
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        trigger.focus()
      }
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    if (event.target instanceof HTMLInputElement && !event.key.startsWith("Arrow")) return
    const options = items()
    if (!options.length) return
    event.preventDefault()
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length
    options[next]?.focus()
  })
  return focusSelected
}
