import { useState } from "react";
import { Download, GitFork, LoaderCircle, MoreHorizontal, Trash2 } from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { toDate } from "../../lib/timeGroups.js";

// One 32px session row (spec section 3, after LobeHub's topic item): title with
// a fade mask, a running spinner or unread dot, and a 24px overflow button that
// appears on hover/focus. The overflow menu carries Fork, Export replay and a
// confirmed Delete; the current session cannot be deleted from here.
export function SessionRow({ session, id, current, unread, running, canFork, canExport, onSelect, onFork, onExport, onRequestDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = session.title || session.preview || "Untitled session";
  const date = toDate(session.updated_at);

  const items = [
    ...(canFork ? [{ id: "fork", label: "Fork", icon: <GitFork size={14} />, onSelect: () => onFork?.(id) }] : []),
    ...(canExport ? [{ id: "export", label: "Export replay", icon: <Download size={14} />, onSelect: () => onExport?.(id) }] : []),
    ...(canFork || canExport ? [{ separator: true }] : []),
    {
      id: "delete",
      label: current ? "Delete (switch away first)" : "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: current,
      onSelect: () => onRequestDelete?.(id, title),
    },
  ];

  return (
    <div className={`session-item${current ? " selected" : ""}${menuOpen ? " menu-open" : ""}`} data-session-id={id}>
      <button
        type="button"
        className="session-main"
        aria-current={current ? "page" : undefined}
        title={date ? `${title}\n${date.toLocaleString()}` : title}
        onClick={() => onSelect?.(id)}
      >
        <span className="session-title">{title}</span>
        {running ? (
          <LoaderCircle size={13} className="spin session-running" aria-label="Running" />
        ) : unread ? (
          <span className="session-unread" role="img" aria-label="Unread" />
        ) : null}
      </button>
      <Menu
        label={`Actions for ${title}`}
        items={items}
        className="session-menu"
        onOpenChange={setMenuOpen}
        trigger={(props) => (
          <button type="button" className="session-more" aria-label={`More actions for ${title}`} {...props}>
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  );
}
