import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
import { basename } from "../../lib/format.js";

// Project selector (spec section 3): a 32px row with a folder icon, the
// project name and a chevron. When connected to a Rind Desktop host
// (`allowCustomFolder === false`), only folders added in the host's Workspaces
// panel are selectable.
export function ProjectSelector({
  workspace,
  workspaces = [],
  busy,
  message,
  draft,
  onDraftChange,
  onSelect,
  allowCustomFolder = true,
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);
  const paths = allowCustomFolder
    ? [...new Set([workspace, ...workspaces].filter(Boolean))]
    : [...new Set(workspaces.filter(Boolean))];
  const activeWorkspace = allowCustomFolder
    ? workspace
    : (paths.includes(workspace) ? workspace : (paths[0] || ""));

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const items = [
    ...paths.map((path) => ({
      id: `project-${path}`,
      label: basename(path),
      hint: path === activeWorkspace ? <Check size={14} aria-label="Current project" /> : undefined,
      icon: <Folder size={14} />,
      onSelect: () => path !== activeWorkspace && onSelect?.(path),
    })),
    ...(allowCustomFolder
      ? [
          ...(paths.length ? [{ separator: true }] : []),
          {
            id: "project-open",
            label: "Open another folder…",
            icon: <FolderOpen size={14} />,
            onSelect: () => setEditing(true),
          },
        ]
      : paths.length === 0
        ? [
            {
              id: "project-empty",
              label: "No folders added in Workspaces",
              disabled: true,
            },
          ]
        : []),
  ];

  function apply() {
    const value = String(draft || "").trim();
    if (!value || busy) return;
    onSelect?.(value);
    setEditing(false);
  }

  return (
    <div className="project-selector">
      <Menu
        label="Projects"
        align="start"
        items={items}
        className="project-menu"
        trigger={(props) => (
          <button
            type="button"
            className="project-trigger"
            aria-label={`Project: ${basename(activeWorkspace) || "none"}`}
            title={activeWorkspace || undefined}
            disabled={busy}
            {...props}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <Folder size={16} aria-hidden="true" />
            )}
            <span className="project-name">{basename(activeWorkspace) || "Choose a project"}</span>
            <ChevronsUpDown size={14} className="project-chevron" aria-hidden="true" />
          </button>
        )}
      />
      {activeWorkspace && (
        <div className="project-workspace" title={activeWorkspace}>
          <span>Folder on Rind computer</span>
          <code>{activeWorkspace}</code>
        </div>
      )}
      {allowCustomFolder && editing && (
        <div className="project-path-row">
          <label htmlFor="workspace-path" className="visually-hidden">
            Folder on your Rind computer
          </label>
          <input
            id="workspace-path"
            ref={inputRef}
            value={draft || ""}
            placeholder="Path on the Rind computer"
            onChange={(event) => onDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing) return;
              if (event.key === "Enter") apply();
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Use selected directory"
            disabled={busy || !String(draft || "").trim()}
            onClick={apply}
          >
            {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel"
            onClick={() => setEditing(false)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {message && (
        <div className="workspace-message" role="alert">
          {message}
        </div>
      )}
    </div>
  );
}
