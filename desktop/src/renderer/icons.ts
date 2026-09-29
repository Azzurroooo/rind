import { createElement, type IconNode } from "lucide"

/** Decorative icon markup. Buttons that carry only an icon must set aria-label. */
export function renderIcon(icon: IconNode, className = "topbar-icon") {
  return createElement(icon, {
    class: className,
    "aria-hidden": "true",
    focusable: "false",
  }).outerHTML
}

export {
  ArrowDown,
  ArrowUp,
  Bell,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Download,
  Ellipsis,
  GitBranch,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  PanelLeft,
  PanelRight,
  Pencil,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide"
