import { useMemo, useState } from "react";
import { BarChart3, Bell, History, Search, Settings, SquarePen, X } from "lucide-react";
import { ConfirmDialog } from "../overlays/ConfirmDialog.jsx";
import { ProjectSelector } from "./ProjectSelector.jsx";
import { SessionRow } from "./SessionRow.jsx";
import { interactionTime } from "../../lib/sessionActivity.js";
import { sessionIdOf } from "../../methods.js";

// Sidebar (spec section 3), after Jan's left panel and LobeHub's topic list:
// project selector, New session, a title search, recent 32px session
// rows, "Load more", and a footer with notifications and Settings.
export function Sidebar({
  sessions,
  activeId,
  unreadIds,
  runningIds,
  hasMore,
  project,
  canFork,
  canExport,
  notificationPermission,
  onNew,
  onSelect,
  onFork,
  onExport,
  onDelete,
  onLoadMore,
  onEnableNotifications,
  onOpenSettings,
  onOpenUsage,
  panelAttrs = {},
  panelRef,
  style,
}) {
  const { className: panelClassName = "", ...restPanelAttrs } = panelAttrs;
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(null); // { id, title, busy, error }
  const [loadingMore, setLoadingMore] = useState(false);

  const recent = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? sessions.filter((session) => String(session.title || session.preview || sessionIdOf(session)).toLowerCase().includes(needle))
      : sessions;
    return [...list].sort((a, b) => interactionTime(b) - interactionTime(a));
  }, [sessions, search]);

  async function confirmDelete() {
    if (!pending) return;
    setPending({ ...pending, busy: true, error: "" });
    try {
      await onDelete?.(pending.id);
      setPending(null);
    } catch (error) {
      setPending((current) => current && { ...current, busy: false, error: error instanceof Error ? error.message : String(error || "Delete failed") });
    }
  }

  return (
    <aside ref={panelRef} id="sidebar-panel" className={`sidebar ${panelClassName}`.trim()} tabIndex={-1} style={style} aria-label="Sessions sidebar" {...restPanelAttrs}>
      <div className="sidebar-head">
        <span className="sidebar-section-label">Projects</span>
        <ProjectSelector {...project} />
        <button type="button" className="sidebar-new" title={project?.workspace ? `New session in ${project.workspace}` : undefined} onClick={onNew} disabled={!project?.workspace}>
          <SquarePen size={16} aria-hidden="true" />
          <span>New session</span>
        </button>
      </div>
      <div className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          id="sidebar-search-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && search) { event.stopPropagation(); setSearch(""); } }}
          placeholder="Search sessions"
          aria-label="Search sessions"
        />
        {search && (
          <button type="button" className="sidebar-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="session-list" aria-label="Sessions">
        <h2 className="sidebar-section-label">Recent sessions</h2>
        {recent.length === 0 ? (
          <div className="sidebar-empty"><History size={15} aria-hidden="true" />{" "}{search ? "No matching sessions" : "No sessions yet"}</div>
        ) : recent.map((session) => {
          const id = sessionIdOf(session);
          const current = id === activeId;
          return (
            <SessionRow
              key={id}
              session={session}
              id={id}
              current={current}
              unread={!current && Boolean(unreadIds?.has?.(id))}
              running={Boolean(runningIds?.has?.(id))}
              canFork={canFork}
              canExport={canExport}
              onSelect={onSelect}
              onFork={onFork}
              onExport={onExport}
              onRequestDelete={(targetId, title) => setPending({ id: targetId, title, busy: false, error: "" })}
            />
          );
        })}
        {hasMore && !search && (
          <button type="button" className="load-more" disabled={loadingMore} onClick={async () => {
            setLoadingMore(true);
            try { await onLoadMore?.(); } finally { setLoadingMore(false); }
          }}>{loadingMore ? "Loading…" : "Load more"}</button>
        )}
      </nav>
      <div className="sidebar-footer">
        {onOpenUsage && <button type="button" className="sidebar-footer-button" onClick={onOpenUsage}><BarChart3 size={15} aria-hidden="true" /><span>Usage</span></button>}
        {notificationPermission === "default" && onEnableNotifications && (
          <button type="button" className="sidebar-footer-button sidebar-notifications" aria-label="Enable desktop notifications" title="Enable desktop notifications while this page is hidden" onClick={onEnableNotifications}>
            <Bell size={15} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="sidebar-footer-button" aria-label="Open settings" onClick={onOpenSettings}>
          <Settings size={15} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(pending)}
        title="Delete session?"
        message={pending ? `"${pending.title}" and its history will be removed from the Rind computer.` : ""}
        confirmLabel={pending?.busy ? "Deleting…" : "Delete"}
        danger
        busy={pending?.busy}
        error={pending?.error}
        onConfirm={confirmDelete}
        onCancel={() => setPending(null)}
      />
    </aside>
  );
}
