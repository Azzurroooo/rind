import { createElement, type IconNode } from "lucide"

export function renderIcon(icon: IconNode) {
  return createElement(icon, {
    class: "topbar-icon",
    "aria-hidden": "true",
    focusable: "false",
  }).outerHTML
}

export { PanelLeft, PanelRight, Settings } from "lucide"
