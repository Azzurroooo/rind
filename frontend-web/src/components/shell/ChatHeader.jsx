import {
  Command,
  Crown,
  Download,
  GitFork,
  Kanban,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelLeft,
  PanelRight,
  Sparkles,
} from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { Tooltip } from "../overlays/Tooltip.jsx";

// Chat header (spec section 2): 44px (48px on narrow screens) with the sidebar
// toggle, the session title, agent/team context badge, and status chip on the
// left, and 28px icon buttons on the right.
export function ChatHeader({
  title,
  status,
  agentContext,
  surface,
  sidebarExpanded,
  inspectorExpanded,
  sidebarToggleRef,
  inspectorToggleRef,
  showTasks,
  menuItems,
  onToggleSidebar,
  onToggleInspector,
  onOpenTasks,
  onOpenTeam,
  onBackToChat,
}) {
  const isChatSurface = !surface || surface.kind === "chat";

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
      {isChatSurface && agentContext?.kind === "manager" && (
        <span className="header-agent-pill manager" title="Talking with the Organization Manager">
          <Sparkles size={12} aria-hidden="true" />
          <span>Manager · Coordinator</span>
        </span>
      )}
      {isChatSurface && agentContext?.kind === "member" && (
        <div className="header-agent-breadcrumb">
          <button
            type="button"
            className="header-agent-pill member"
            title={`View ${agentContext.teamName} organization`}
            onClick={() => onOpenTeam?.(agentContext.teamId, "organization")}
          >
            {agentContext.isLeader ? <Crown size={11} aria-hidden="true" /> : <Network size={11} aria-hidden="true" />}
            <span>{agentContext.teamName}</span>
            <span className="header-agent-sep">/</span>
            <strong>{agentContext.agentName}</strong>
            <span className="header-agent-role">{agentContext.roleLabel}</span>
          </button>
          <button
            type="button"
            className="header-agent-pill subtle"
            title={`Open ${agentContext.teamName} tasks board`}
            onClick={() => onOpenTeam?.(agentContext.teamId, "tasks")}
          >
            <Kanban size={11} aria-hidden="true" />
            <span>Board</span>
          </button>
        </div>
      )}
      {!isChatSurface && onBackToChat && (
        <button type="button" className="header-agent-pill back-chat" onClick={onBackToChat}>
          <MessageSquare size={12} aria-hidden="true" />
          <span>Back to Conversation</span>
        </button>
      )}
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
