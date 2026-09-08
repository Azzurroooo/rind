import { createElement, type IconNode } from "lucide"

export function renderIcon(icon: IconNode) {
  return createElement(icon, {
    class: "topbar-icon",
    "aria-hidden": "true",
    focusable: "false",
  }).outerHTML
}

export type { IconNode }
export { Keyboard, ListTodo, Monitor, Moon, PanelLeft, PanelRight, Search, Settings, Sun } from "lucide"
