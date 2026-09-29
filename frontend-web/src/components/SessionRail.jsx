import { Fragment, useMemo, useState } from "react";
import { Bell, Check, ChevronRight, CirclePlus, FolderOpen, History, LoaderCircle, MessageSquareText, Search, Trash2 } from "lucide-react";
import { FileTree } from "./FileTree.jsx";
import { sessionIdOf } from "../methods.js";

// Session rail (web-ui.md §1/§5): session list with 6px unread dots on
// non-current sessions receiving durable events (cleared on switch), inline
// one-click delete confirm (no modal; current session's delete is disabled
// with a tooltip), an unobtrusive notification-permission button in the
// footer, and the read-only workspace file tree panel.
//
// Search + pagination (audit #9): the search box filters by title
// client-side; "Load more" asks App for the next page of the session list
// (server has no offset — App re-requests with a larger limit). Delete keeps
// its inline confirm.
export function SessionRail({
  sessions,
  activeId,
  loading,
  workspace,
  workspaces = [],
  onWorkspaceSelect,
  workspaceDraft,
  workspaceBusy,
  workspaceMessage,
  unreadIds,
  notificationPermission,
  fileTree,
  hasMore = false,
  onLoadMore,
  onWorkspaceDraftChange,
  onWorkspaceApply,
  onNew,
  onSelect,
  onDelete,
  onEnableNotifications,
  // Mobile drawer wiring (master plan §6.2): App passes the panel id,
  // drawer-open/closed class and aria-hidden/inert state; empty on desktop.
  panelAttrs = {},
  panelRef,
}) {
  const { className: panelClassName = "", ...restPanelAttrs } = panelAttrs;
  const [confirmingId, setConfirmingId] = useState("");
  const [deleteError, setDeleteError] = useState({});
  const [search, setSearch] = useState("");

  // Client-side title filter, always applied to the freshly loaded list.
  const visibleSessions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => String(session.title || session.preview || sessionIdOf(session)).toLowerCase().includes(needle));
  }, [sessions, search]);

  async function confirmDelete(id) {
    try {
      await onDelete?.(id);
      setDeleteError((current) => ({ ...current, [id]: "" }));
    } catch (error) {
      setDeleteError((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error || "Delete failed") }));
    } finally {
      setConfirmingId((current) => (current === id ? "" : current));
    }
  }

  return (
    <aside ref={panelRef} className={`session-rail ${panelClassName}`.trim()} tabIndex={-1} {...restPanelAttrs}>
      <div className="rail-heading">
        <div>
          <h2>Workspace</h2>
        </div>
        <button className="icon-button" title="New session in selected workspace" onClick={onNew} disabled={!workspace}><CirclePlus size={18} /></button>
      </div>
      <div className="workspace-picker">
        <label htmlFor="workspace-select">Project</label>
        <select id="workspace-select" aria-label="Project" value={workspace || ""} disabled={workspaceBusy} onChange={(event) => onWorkspaceSelect?.(event.target.value)}>{[...new Set([workspace, ...workspaces].filter(Boolean))].map((path) => <option key={path} value={path}>{path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path}</option>)}</select>
        <details className="workspace-location"><summary>Open another folder</summary>
        <label htmlFor="workspace-path">Folder on your Rind computer</label>
        <div className="workspace-input-row"><FolderOpen size={15} /><input id="workspace-path" value={workspaceDraft || ""} onChange={(event) => onWorkspaceDraftChange(event.target.value)} onKeyDown={(event) => !event.nativeEvent.isComposing && event.key === "Enter" && onWorkspaceApply()} placeholder="Path on the Rind computer" /><button className="icon-button subtle" title="Use selected directory" onClick={onWorkspaceApply} disabled={workspaceBusy || !(workspaceDraft || "").trim()}>{workspaceBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</button></div>
        </details>
        {workspaceMessage && <div className="workspace-message" role="alert">{workspaceMessage}</div>}
      </div>
      <div className="rail-rule" />
      <div className="sessions-heading"><span>Sessions</span><span>{visibleSessions.length}</span></div>
      <div className="session-search">
        <Search size={13} />
        <input
          id="rail-search-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search session titles…"
          aria-label="Search sessions"
        />
        {search && <button type="button" className="session-search-clear" title="Clear search" onClick={() => setSearch("")}>×</button>}
      </div>
      {loading ? <div className="rail-empty"><LoaderCircle className="spin" size={16} /> Loading sessions</div> : visibleSessions.length ? (
        <nav className="session-list" aria-label="Sessions">
          {visibleSessions.map((session, index) => {
            const id = sessionIdOf(session);
            const current = id === activeId;
            const unread = !current && unreadIds?.has?.(id);
            const group = sessionDateGroup(session.updated_at);
            const date = new Date(session.updated_at);
            return (
              <Fragment key={id}>
              {(index === 0 || sessionDateGroup(visibleSessions[index - 1].updated_at) !== group) && <div className="session-date-group">{group}</div>}
              <div className={`session-item ${current ? "selected" : ""}`} data-session-id={id}>
                {unread && <span className="session-unread" title="New activity" aria-label="Unread" />}
                <button className="session-main" aria-current={current ? "page" : undefined} onClick={() => onSelect(id)}>
                  <MessageSquareText size={16} />
                  <span className="session-copy"><strong>{session.title || session.preview || "Untitled session"}</strong><small title={Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()}>{Number.isNaN(date.getTime()) ? "Conversation" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span>
                  {current && <ChevronRight size={15} className="selected-arrow" />}
                </button>
                {current ? (
                  <button className="icon-button subtle session-delete" title="Current session cannot be deleted" disabled><Trash2 size={14} /></button>
                ) : confirmingId === id ? (
                  <span className="session-confirm" role="alertdialog" aria-label={`Confirm delete session ${id}`}>
                    Delete?
                    <button className="confirm-yes" onClick={() => confirmDelete(id)}>Yes</button>
                    <button className="confirm-no" onClick={() => setConfirmingId("")}>No</button>
                  </span>
                ) : (
                  <button className="icon-button subtle session-delete" title="Delete session" onClick={() => { setDeleteError((current) => ({ ...current, [id]: "" })); setConfirmingId(id); }}><Trash2 size={14} /></button>
                )}
                {deleteError[id] && <div className="session-delete-error" role="alert">{deleteError[id]}</div>}
              </div>
              </Fragment>
            );
          })}
        </nav>
      ) : <div className="rail-empty"><History size={16} /> {search ? "No matching sessions" : "No sessions yet"}</div>}
      {!loading && hasMore && (
        <button type="button" className="load-more" onClick={() => onLoadMore?.()}>Load more</button>
      )}
      <FileTree key={workspace} workspace={workspace} listFiles={fileTree?.listFiles} readFile={fileTree?.readFile} />
      <div className="rail-footer">
        <span>Connected to your Rind workspace.</span>
        {notificationPermission === "default" && onEnableNotifications && (
          <button className="notif-button" title="System notifications arrive only while the page is hidden" onClick={onEnableNotifications}><Bell size={12} /> Enable desktop notifications</button>
        )}
      </div>
    </aside>
  );
}

function sessionDateGroup(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sessions";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 7);
  return date >= today ? "Today" : date >= yesterday ? "Yesterday" : date >= week ? "Previous 7 days" : "Earlier";
}
