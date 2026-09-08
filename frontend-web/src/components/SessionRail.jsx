import { useMemo, useState } from "react";
import { Bell, Check, ChevronRight, CirclePlus, FolderOpen, History, LoaderCircle, MessageSquareText, Search, Trash2 } from "lucide-react";
import { FileTree } from "./FileTree.jsx";
import { sessionIdOf } from "../methods.js";
import { relativeTime } from "../lib/time.js";

// Session rail (web-ui.md §1/§5): session list with 6px unread dots on
// non-current sessions receiving durable events (cleared on switch), inline
// one-click delete confirm (no modal; current session's delete is disabled
// with a tooltip), an unobtrusive notification-permission button in the
// footer, and the read-only workspace file tree panel.
//
// Search + pagination (audit #9): the search box filters by title
// client-side; "加载更多" asks App for the next page of the session list
// (server has no offset — App re-requests with a larger limit). Delete keeps
// its inline confirm.
export function SessionRail({
  sessions,
  activeId,
  loading,
  workspace,
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
      setDeleteError((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error || "删除失败") }));
    } finally {
      setConfirmingId((current) => (current === id ? "" : current));
    }
  }

  return (
    <aside ref={panelRef} className={`session-rail ${panelClassName}`.trim()} tabIndex={-1} {...restPanelAttrs}>
      <div className="rail-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h2>Choose a directory</h2>
        </div>
        <button className="icon-button" title="New session in selected workspace" onClick={onNew} disabled={!workspace}><CirclePlus size={18} /></button>
      </div>
      <div className="workspace-picker">
        <label htmlFor="workspace-path">Selected directory</label>
        <div className="workspace-input-row"><FolderOpen size={15} /><input id="workspace-path" value={workspaceDraft || ""} onChange={(event) => onWorkspaceDraftChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onWorkspaceApply()} placeholder="E:\\projects\\rind" /><button className="icon-button subtle" title="Use selected directory" onClick={onWorkspaceApply} disabled={workspaceBusy || !(workspaceDraft || "").trim()}>{workspaceBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</button></div>
        {workspaceMessage ? <div className="workspace-message">{workspaceMessage}</div> : <div className="workspace-hint">{workspace || "Choose the worker-visible path"}</div>}
      </div>
      <div className="rail-rule" />
      <div className="sessions-heading"><span>Sessions</span><span>{visibleSessions.length}</span></div>
      <div className="session-search">
        <Search size={13} />
        <input
          id="rail-search-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索会话标题…"
          aria-label="搜索会话"
        />
        {search && <button type="button" className="session-search-clear" title="清除搜索" onClick={() => setSearch("")}>×</button>}
      </div>
      {loading ? <div className="rail-empty"><LoaderCircle className="spin" size={16} /> Loading sessions</div> : visibleSessions.length ? (
        <nav className="session-list" aria-label="Sessions">
          {visibleSessions.map((session) => {
            const id = sessionIdOf(session);
            const current = id === activeId;
            const unread = !current && unreadIds?.has?.(id);
            return (
              <div key={id} className={`session-item ${current ? "selected" : ""}`} data-session-id={id}>
                {unread && <span className="session-unread" title="有新动态" aria-label="未读" />}
                <button className="session-main" onClick={() => onSelect(id)} title={session.preview || ""}>
                  <MessageSquareText size={16} />
                  <span className="session-copy"><strong>{session.title || session.preview || "Untitled session"}</strong><small>{relativeTime(session.updated_at)}{session.preview ? ` · ${session.preview}` : ""}</small></span>
                  {current && <ChevronRight size={15} className="selected-arrow" />}
                </button>
                {current ? (
                  <button className="icon-button subtle session-delete" title="当前会话不可删除" disabled><Trash2 size={14} /></button>
                ) : confirmingId === id ? (
                  <span className="session-confirm" role="alertdialog" aria-label={`确认删除会话 ${id}`}>
                    删除？
                    <button className="confirm-yes" onClick={() => confirmDelete(id)}>是</button>
                    <button className="confirm-no" onClick={() => setConfirmingId("")}>否</button>
                  </span>
                ) : (
                  <button className="icon-button subtle session-delete" title="删除会话" onClick={() => { setDeleteError((current) => ({ ...current, [id]: "" })); setConfirmingId(id); }}><Trash2 size={14} /></button>
                )}
                {deleteError[id] && <div className="session-delete-error" role="alert">{deleteError[id]}</div>}
              </div>
            );
          })}
        </nav>
      ) : <div className="rail-empty"><History size={16} /> {search ? "没有匹配的会话" : "No sessions yet"}</div>}
      {!loading && hasMore && (
        <button type="button" className="load-more" onClick={() => onLoadMore?.()}>加载更多</button>
      )}
      <FileTree workspace={workspace} listFiles={fileTree?.listFiles} readFile={fileTree?.readFile} />
      <div className="rail-footer">
        <span>Long-lived worker · browser-safe disconnect</span>
        {notificationPermission === "default" && onEnableNotifications && (
          <button className="notif-button" title="仅页面隐藏时才会收到系统通知" onClick={onEnableNotifications}><Bell size={12} /> 开启桌面通知</button>
        )}
      </div>
    </aside>
  );
}
