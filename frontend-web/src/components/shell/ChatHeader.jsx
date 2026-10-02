import { Command, Download, GitFork, ListChecks, MoreHorizontal, PanelLeft, PanelRight, Sparkles } from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { Tooltip } from "../overlays/Tooltip.jsx";

// Chat header (spec section 2): 44px (48px on narrow screens) with the sidebar
// toggle, the session title and a status chip on the left, and 28px icon
// buttons (tasks, inspector toggle, overflow) on the right.
export function ChatHeader({
  title,
  status,
  sidebarExpanded,
  inspectorExpanded,
  sidebarToggleRef,
  inspectorToggleRef,
  showTasks,
  menuItems,
  onToggleSidebar,
  onToggleInspector,
  onOpenTasks,
}) {
  return (
    <header className="chat-header">
      <Tooltip label="Toggle sidebar (Ctrl+B)">
        <button
          ref={sidebarToggleRef}
          type="button"
          className="icon-button header-button"
          aria-label="Toggle sidebar"
          aria-expanded={sidebarExpanded}
          aria-controls="sidebar-panel"
          onClick={onToggleSidebar}
        >
          <PanelLeft size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <h1 className="chat-title" title={title}>{title}</h1>
      {status && <span className={`status-chip ${status.tone || ""}`.trim()}>{status.label}</span>}
      <div className="chat-header-actions">
        {showTasks && (
          <Tooltip label="Tasks">
            <button type="button" className="icon-button header-button" aria-label="Open tasks" onClick={onOpenTasks}>
              <ListChecks size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Toggle inspector">
          <button
            ref={inspectorToggleRef}
            type="button"
            className="icon-button header-button"
            aria-label="Toggle inspector"
            aria-expanded={inspectorExpanded}
            aria-controls="inspector-panel"
            onClick={onToggleInspector}
          >
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        <Menu
          label="Session actions"
          items={menuItems}
          trigger={(props) => (
            <button type="button" className="icon-button header-button" aria-label="Session actions" {...props}>
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          )}
        />
      </div>
    </header>
  );
}

// Overflow items for the current session; unavailable actions are disabled
// rather than hidden so the menu keeps a stable shape.
export function headerMenuItems({ hasSession, active, canFork, compacting, onPalette, onFork, onExport, onCompact }) {
  return [
    { id: "palette", label: "Command palette", icon: <Command size={14} />, hint: "Ctrl+K", onSelect: onPalette },
    { separator: true },
    ...(canFork ? [{ id: "fork", label: "Fork session", icon: <GitFork size={14} />, disabled: !hasSession || active, onSelect: onFork }] : []),
    { id: "export", label: "Export replay", icon: <Download size={14} />, disabled: !hasSession, onSelect: onExport },
    { id: "compact", label: compacting ? "Compacting…" : "Compact context", icon: <Sparkles size={14} />, disabled: !hasSession || compacting || active, onSelect: onCompact },
  ];
}
