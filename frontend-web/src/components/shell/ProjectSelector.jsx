import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  CornerLeftUp,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { Dialog } from "../overlays/Dialog.jsx";
import { Menu } from "../overlays/Menu.jsx";
import { normalizePathKey } from "../../lib/agentsModel.js";
import { basename } from "../../lib/format.js";

function dedupeWorkspacePaths(list) {
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const trimmed = String(item || "").trim();
    const key = normalizePathKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function buildBreadcrumbs(fullPath) {
  const raw = String(fullPath || "").trim();
  if (!raw) return [];
  const isWin = /^[A-Za-z]:/.test(raw) || raw.includes("\\");
  const sep = isWin ? "\\" : "/";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (isWin) {
    if (parts.length === 0) return [];
    const drive = parts[0];
    const crumbs = [{ label: drive, path: `${drive}\\` }];
    let acc = `${drive}`;
    for (let i = 1; i < parts.length; i += 1) {
      acc = `${acc}${sep}${parts[i]}`;
      crumbs.push({ label: parts[i], path: acc });
    }
    return crumbs;
  }
  const crumbs = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

// Project selector (spec section 3): a 32px row with a folder icon, the
// project name and a chevron, plus a remote directory browser when connected
// to a gateway that advertises `workspace/dirs`.
export function ProjectSelector({
  workspace,
  workspaces = [],
  busy,
  message,
  draft,
  onDraftChange,
  onSelect,
  onBrowseDirs,
  allowCustomFolder = true,
}) {
  const [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [browseInput, setBrowseInput] = useState("");
  const [browseFilter, setBrowseFilter] = useState("");
  const [browseData, setBrowseData] = useState({
    current: "",
    parent: "",
    roots: [],
    directories: [],
  });
  const inputRef = useRef(null);
  const browseRequestRef = useRef(0);

  const paths = useMemo(
    () =>
      allowCustomFolder
        ? dedupeWorkspacePaths([...workspaces, workspace])
        : dedupeWorkspacePaths(workspaces),
    [allowCustomFolder, workspace, workspaces],
  );

  const matchedWorkspace = useMemo(
    () => (workspace ? paths.find((p) => normalizePathKey(p) === normalizePathKey(workspace)) || "" : ""),
    [paths, workspace],
  );

  const activeWorkspace = allowCustomFolder
    ? matchedWorkspace || workspace
    : matchedWorkspace || paths[0] || "";

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function navigateDir(targetPath = "") {
    if (typeof onBrowseDirs !== "function") return;
    const reqId = ++browseRequestRef.current;
    setBrowseBusy(true);
    setBrowseError("");
    try {
      const result = await onBrowseDirs(String(targetPath || "").trim());
      if (reqId !== browseRequestRef.current) return;
      const current = String(result?.current || targetPath || "").trim();
      setBrowseData({
        current,
        parent: String(result?.parent || "").trim(),
        roots: Array.isArray(result?.roots) ? result.roots : [],
        directories: Array.isArray(result?.directories) ? result.directories : [],
      });
      setBrowseInput(current);
      setBrowseFilter("");
    } catch (error) {
      if (reqId !== browseRequestRef.current) return;
      setBrowseError(error instanceof Error ? error.message : String(error || "Unable to list folder"));
    } finally {
      if (reqId === browseRequestRef.current) {
        setBrowseBusy(false);
      }
    }
  }

  function openFolderBrowser() {
    const initialPath = activeWorkspace || "";
    setBrowsing(true);
    setBrowseInput(initialPath);
    setBrowseFilter("");
    setBrowseError("");
    void navigateDir(initialPath);
  }

  const items = [
    ...paths.map((path) => {
      const isCurrent = normalizePathKey(path) === normalizePathKey(activeWorkspace);
      return {
        id: `project-${path}`,
        label: basename(path),
        hint: isCurrent ? <Check size={14} aria-label="Current project" /> : undefined,
        icon: <Folder size={14} />,
        onSelect: () => !isCurrent && onSelect?.(path),
      };
    }),
    ...(allowCustomFolder
      ? [
          ...(paths.length ? [{ separator: true }] : []),
          {
            id: "project-open",
            label: "Open another folder…",
            icon: <FolderOpen size={14} />,
            onSelect: () => {
              if (typeof onBrowseDirs === "function") {
                openFolderBrowser();
              } else {
                onDraftChange?.(activeWorkspace || "");
                setEditing(true);
              }
            },
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

  const targetOpenPath = String(browseInput || browseData.current || "").trim();
  const breadcrumbs = useMemo(() => buildBreadcrumbs(browseData.current), [browseData.current]);
  const filteredDirs = useMemo(() => {
    const needle = browseFilter.trim().toLowerCase();
    if (!needle) return browseData.directories;
    return browseData.directories.filter((dir) =>
      String(dir.name || "").toLowerCase().includes(needle),
    );
  }, [browseData.directories, browseFilter]);

  function confirmBrowseSelection() {
    if (!targetOpenPath || busy) return;
    onDraftChange?.(targetOpenPath);
    onSelect?.(targetOpenPath);
    setBrowsing(false);
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
      <Dialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        title="Open folder on Rind computer"
        size="md"
        className="folder-browser-dialog"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setBrowsing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!targetOpenPath || busy || browseBusy}
              onClick={confirmBrowseSelection}
            >
              {`Open "${basename(targetOpenPath) || targetOpenPath || "folder"}"`}
            </button>
          </>
        }
      >
        <div className="folder-browser">
          <form
            className="folder-browser-pathbar"
            onSubmit={(event) => {
              event.preventDefault();
              if (browseInput.trim()) void navigateDir(browseInput.trim());
            }}
          >
            <input
              type="text"
              value={browseInput}
              onChange={(event) => setBrowseInput(event.target.value)}
              placeholder="Enter or paste path on Rind computer…"
              aria-label="Folder path on Rind computer"
            />
            <button
              type="submit"
              className="button ghost folder-browser-go"
              disabled={browseBusy || !browseInput.trim()}
            >
              Go
            </button>
          </form>

          {browseData.roots.length > 0 && (
            <div className="folder-browser-roots" role="group" aria-label="Locations">
              {browseData.roots.map((root) => {
                const isRootActive =
                  normalizePathKey(browseData.current).startsWith(normalizePathKey(root.path));
                return (
                  <button
                    key={root.path}
                    type="button"
                    className={`folder-browser-root-chip ${isRootActive ? "active" : ""}`}
                    onClick={() => void navigateDir(root.path)}
                    disabled={browseBusy}
                  >
                    {root.label === "Home" ? (
                      <Home size={12} aria-hidden="true" />
                    ) : (
                      <HardDrive size={12} aria-hidden="true" />
                    )}
                    <span>{root.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {breadcrumbs.length > 0 && (
            <nav className="folder-browser-crumbs" aria-label="Current path">
              {breadcrumbs.map((crumb, index) => (
                <span key={crumb.path} className="folder-browser-crumb-wrap">
                  {index > 0 && <ChevronRight size={12} className="folder-browser-crumb-sep" aria-hidden="true" />}
                  <button
                    type="button"
                    className={`folder-browser-crumb ${index === breadcrumbs.length - 1 ? "current" : ""}`}
                    onClick={() => void navigateDir(crumb.path)}
                    disabled={browseBusy}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          )}

          {browseData.directories.length > 5 && (
            <div className="folder-browser-filter">
              <Search size={13} aria-hidden="true" />
              <input
                type="text"
                value={browseFilter}
                onChange={(event) => setBrowseFilter(event.target.value)}
                placeholder="Filter folders…"
                aria-label="Filter subfolders"
              />
              {browseFilter && (
                <button
                  type="button"
                  className="sidebar-search-clear"
                  aria-label="Clear folder filter"
                  onClick={() => setBrowseFilter("")}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {browseError && (
            <div className="workspace-message" role="alert">
              {browseError}
            </div>
          )}

          <div className="folder-browser-list" role="listbox" aria-label="Subfolders">
            {browseData.parent && (
              <button
                type="button"
                className="folder-browser-item parent"
                onClick={() => void navigateDir(browseData.parent)}
                disabled={browseBusy}
              >
                <CornerLeftUp size={15} aria-hidden="true" />
                <span className="folder-browser-item-name">.. (Parent folder)</span>
              </button>
            )}
            {browseBusy && browseData.directories.length === 0 ? (
              <div className="folder-browser-empty">
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
                <span>Loading folders…</span>
              </div>
            ) : filteredDirs.length === 0 ? (
              <div className="folder-browser-empty">
                {browseFilter ? "No matching subfolders" : "No subfolders in this directory"}
              </div>
            ) : (
              filteredDirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  className="folder-browser-item"
                  onClick={() => void navigateDir(dir.path)}
                  disabled={browseBusy}
                >
                  <Folder size={15} aria-hidden="true" />
                  <span className="folder-browser-item-name">{dir.name}</span>
                  <ChevronRight size={14} className="folder-browser-item-chevron" aria-hidden="true" />
                </button>
              ))
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
