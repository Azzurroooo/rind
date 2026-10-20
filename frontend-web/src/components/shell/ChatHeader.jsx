import {
  ChevronDown,
  Command,
  Crown,
  Download,
  GitFork,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelLeft,
  PanelRight,
  Plus,
  Sparkles,
} from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { Tooltip } from "../overlays/Tooltip.jsx";

// Chat header (spec section 2): 44px (48px on narrow screens) with the sidebar
// toggle, the session title, agent/team context badge, member/manager session
// switcher, and status chip on the left, and 28px icon buttons on the right.
export function ChatHeader({
  title,
  status,
  activeSessionId = "",
  agentContext,
  memberSessions = [],
  managerSessions = [],
  teamTaskCount = 0,
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
  onOpenManagerView,
  onOpenAgentConversation,
  onBackToChat,
}) {
  const isChatSurface = !surface || surface.kind === "chat";

  const scopedSessions =
    agentContext?.kind === "member"
      ? memberSessions
      : agentContext?.kind === "manager"
        ? managerSessions
        : [];

  const sessionSwitchItems = [
    {
      id: "new-agent-chat",
      label:
        agentContext?.kind === "manager"
          ? "New conversation with Manager"
          : `New conversation with ${agentContext?.agentName || "member"}`,
      icon: <Plus size={14} />,
      onSelect: () =>
        onOpenAgentConversation?.(
          agentContext?.kind === "manager"
            ? { manager: true, forceNew: true }
            : { teamId: agentContext?.teamId, agentId: agentContext?.agentId, forceNew: true },
        ),
    },
    ...(scopedSessions.length > 0 ? [{ separator: true }] : []),
    ...scopedSessions.slice(0, 12).map((sess) => ({
      id: `sess:${sess.runtimeSessionId}`,
      label: sess.title,
      active: sess.runtimeSessionId === activeSessionId,
      hint: [sess.status !== "Idle" ? sess.status : "", sess.ageText].filter(Boolean).join(" · "),
      icon: <MessageSquare size={13} />,
      onSelect: () =>
        onOpenAgentConversation?.(
          agentContext?.kind === "manager"
            ? { manager: true, runtimeSessionId: sess.runtimeSessionId }
            : {
                teamId: agentContext?.teamId,
                agentId: agentContext?.agentId,
                runtimeSessionId: sess.runtimeSessionId,
              },
        ),
    })),
  ];

  if (!isChatSurface) {
    return (
      <header className="chat-header agent-surface-topbar">
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
        <div className="agent-topbar-crumb">
          <span className="agent-topbar-section">Agents &amp; Teams</span>
          <span className="header-agent-sep">/</span>
          <span className="agent-topbar-current">{title}</span>
        </div>
        <div className="chat-header-actions">
          {onBackToChat && (
            <button type="button" className="header-agent-pill back-chat" onClick={onBackToChat}>
              <MessageSquare size={12} aria-hidden="true" />
              <span>Back to Conversation</span>
            </button>
          )}
        </div>
      </header>
    );
  }

  const hasAgentContext =
    agentContext?.kind === "manager" || agentContext?.kind === "member";

  return (
    <header className={`chat-header${hasAgentContext ? " has-agent-context" : ""}`}>
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
      <h1 className="chat-title" title={title}>
        {title}
      </h1>
      {agentContext?.kind === "manager" && (
        <div className="header-agent-breadcrumb">
          <button
            type="button"
            className="header-agent-pill manager"
            title="Open Manager overview & conversations"
            onClick={() => onOpenManagerView?.()}
          >
            <Sparkles size={12} aria-hidden="true" />
            <span>Manager</span>
          </button>
          {onOpenAgentConversation && (
            <Menu
              label="Manager conversations"
              align="start"
              items={sessionSwitchItems}
              trigger={(props) => (
                <button
                  type="button"
                  className="header-agent-pill subtle"
                  title="Switch or start a Manager conversation"
                  {...props}
                >
                  <MessageSquare size={11} aria-hidden="true" />
                  <span>Sessions ({managerSessions.length})</span>
                  <ChevronDown size={11} aria-hidden="true" />
                </button>
              )}
            />
          )}
        </div>
      )}
      {agentContext?.kind === "member" && (
        <div className="header-agent-breadcrumb">
          <button
            type="button"
            className="header-agent-pill member"
            title={`View ${agentContext.teamName} organization`}
            onClick={() => onOpenTeam?.(agentContext.teamId, "organization")}
          >
            {agentContext.isLeader ? (
              <Crown size={11} aria-hidden="true" />
            ) : (
              <Network size={11} aria-hidden="true" />
            )}
            <span>{agentContext.teamName}</span>
            <span className="header-agent-sep">/</span>
            <strong>{agentContext.agentName}</strong>
          </button>
          {onOpenAgentConversation && (
            <Menu
              label={`${agentContext.agentName} conversations`}
              align="start"
              items={sessionSwitchItems}
              trigger={(props) => (
                <button
                  type="button"
                  className="header-agent-pill subtle"
                  title={`Browse ${agentContext.agentName}'s conversations or start a new one`}
                  {...props}
                >
                  <MessageSquare size={11} aria-hidden="true" />
                  <span>Sessions ({memberSessions.length})</span>
                  <ChevronDown size={11} aria-hidden="true" />
                </button>
              )}
            />
          )}
          <button
            type="button"
            className="header-agent-pill subtle"
            title={`Open ${agentContext.teamName} tasks`}
            onClick={() => onOpenTeam?.(agentContext.teamId, "tasks")}
          >
            <ListChecks size={11} aria-hidden="true" />
            <span>Tasks{teamTaskCount > 0 ? ` (${teamTaskCount})` : ""}</span>
          </button>
        </div>
      )}
      {status && <span className={`status-chip ${status.tone || ""}`.trim()}>{status.label}</span>}
      <div className="chat-header-actions">
        {showTasks && (
          <Tooltip label="Current session activity">
            <button
              type="button"
              className="icon-button header-button"
              aria-label="Open session activity"
              onClick={onOpenTasks}
            >
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
