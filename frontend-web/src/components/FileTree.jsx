import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw, X } from "lucide-react";
import { FILE_LIMIT_BYTES, base64ToDataUrl, decodeBase64ToText, formatBytes, isImageMime, isTextMime } from "../lib/files.js";

const PREVIEW_TEXT_CAP = 200_000;

// Read-only workspace file tree (web-ui.md §1 / master plan §6.6 文件树 P1):
// file/list browsing from the workspace root, folders expand lazily one level
// at a time, files preview via file/read (text decoded, images as data URL,
// oversize/binary → size + hint). Loading/empty/error states everywhere; all
// protocol calls arrive via the listFiles/readFile props (App owns the client).
export function FileTree({ workspace, listFiles, readFile }) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState({}); // path → { status: "loading"|"ready"|"error", entries, error }
  const [expanded, setExpanded] = useState({}); // path → bool
  const [preview, setPreview] = useState(null);

  async function loadDir(path) {
    if (!listFiles) return;
    setDirs((state) => {
      const current = state[path];
      if (current?.status === "loading") return state;
      return { ...state, [path]: { status: "loading", entries: current?.entries || [] } };
    });
    try {
      const result = await listFiles(path);
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      setDirs((state) => ({ ...state, [path]: { status: "ready", entries } }));
    } catch (error) {
      setDirs((state) => ({ ...state, [path]: { status: "error", entries: [], error: errorMessage(error) } }));
    }
  }

  function togglePanel() {
    const next = !open;
    setOpen(next);
    if (next && workspace && !dirs[""]) void loadDir("");
  }

  function toggleDir(path) {
    setExpanded((state) => {
      const next = { ...state, [path]: !state[path] };
      if (next[path] && !dirs[path]) void loadDir(path);
      return next;
    });
  }

  async function openPreview(entry) {
    const path = String(entry?.path || entry?.name || "");
    setPreview({ path, status: "loading", size: entry?.size });
    if (Number(entry?.size) > FILE_LIMIT_BYTES) {
      setPreview({ path, status: "oversize", size: entry.size });
      return;
    }
    try {
      const result = await readFile?.(path);
      const mime = String(result?.mime || "");
      const base64 = String(result?.content_base64 || "");
      if (isImageMime(mime)) {
        setPreview({ path, status: "image", mime, size: result?.size, dataUrl: base64ToDataUrl(base64, mime) });
        return;
      }
      if (isTextMime(mime)) {
        const text = decodeBase64ToText(base64);
        setPreview({ path, status: "text", mime, size: result?.size, text: text.slice(0, PREVIEW_TEXT_CAP), truncated: text.length > PREVIEW_TEXT_CAP });
        return;
      }
      setPreview({ path, status: "binary", mime, size: result?.size ?? entry?.size });
    } catch (error) {
      setPreview({ path, status: "error", size: entry?.size, error: errorMessage(error) });
    }
  }

  return (
    <div className="file-tree">
      <button type="button" className="file-tree-header" aria-expanded={open} onClick={togglePanel}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>工作区文件</span>
        <small>{workspace ? "只读" : "无工作区"}</small>
      </button>
      {open && (
        <div className="file-tree-body">
          {!workspace && <div className="tree-state">未选择工作区</div>}
          {workspace && <DirLevel path="" depth={0} state={dirs[""]} expanded={expanded} dirs={dirs} onToggleDir={toggleDir} onOpenFile={openPreview} onRetry={loadDir} />}
          {preview && <PreviewPanel preview={preview} onClose={() => setPreview(null)} />}
        </div>
      )}
    </div>
  );
}

function DirLevel({ path, depth, state, expanded, dirs, onToggleDir, onOpenFile, onRetry }) {
  if (!state || state.status === "loading") {
    return <div className="tree-state indent" style={indent(depth)}><RefreshCw className="spin" size={13} /> 加载中…</div>;
  }
  if (state.status === "error") {
    return (
      <div className="tree-state error indent" style={indent(depth)} role="alert">
        <span>{state.error}</span>
        <button type="button" className="tree-retry" onClick={() => onRetry(path)}>重试</button>
      </div>
    );
  }
  const children = sortEntries(state.entries);
  if (!children.length) {
    return <div className="tree-state indent" style={indent(depth)}>空目录</div>;
  }
  return (
    <>
      {children.map((entry) => {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.type === "dir") {
          const open = Boolean(expanded[childPath]);
          return (
            <div key={childPath} className="tree-branch">
              <button type="button" className="tree-row dir" style={indent(depth)} aria-expanded={open} onClick={() => onToggleDir(childPath)} title={childPath}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {open ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span className="tree-name">{entry.name}</span>
              </button>
              {open && (
                <DirLevel
                  path={childPath}
                  depth={depth + 1}
                  state={dirs[childPath]}
                  expanded={expanded}
                  dirs={dirs}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  onRetry={onRetry}
                />
              )}
            </div>
          );
        }
        return (
          <button type="button" key={childPath} className="tree-row file" style={indent(depth)} onClick={() => onOpenFile({ ...entry, path: childPath })} title={childPath}>
            <FileText size={14} />
            <span className="tree-name">{entry.name}</span>
            {entry.size != null && <small>{formatBytes(entry.size)}</small>}
          </button>
        );
      })}
    </>
  );
}

function PreviewPanel({ preview, onClose }) {
  return (
    <div className="tree-preview" role="region" aria-label={`文件预览 ${preview.path}`}>
      <div className="tree-preview-head">
        <span className="tree-preview-path" title={preview.path}>{preview.path}</span>
        <button type="button" className="tree-preview-close" onClick={onClose} aria-label="关闭预览">×</button>
      </div>
      {preview.status === "loading" && <div className="tree-state"><RefreshCw className="spin" size={14} /> 加载中…</div>}
      {preview.status === "error" && (
        <div className="tree-state error" role="alert">
          <span>{preview.error || "无法读取文件"}</span>
          {preview.size != null && <small>{formatBytes(preview.size)}</small>}
        </div>
      )}
      {preview.status === "oversize" && (
        <div className="tree-state">
          <span>文件过大（{formatBytes(preview.size)}），超出 8 MiB 预览上限</span>
        </div>
      )}
      {preview.status === "binary" && (
        <div className="tree-state">
          <span>二进制文件（{preview.mime || "未知类型"}{preview.size != null ? ` · ${formatBytes(preview.size)}` : ""}），不支持预览</span>
        </div>
      )}
      {preview.status === "image" && <img className="tree-preview-image" src={preview.dataUrl} alt={preview.path} />}
      {preview.status === "text" && (
        <pre className="tree-preview-text">
          {preview.text}
          {preview.truncated ? "\n…（内容过长，已截断）" : ""}
        </pre>
      )}
    </div>
  );
}

// ---- helpers ----

function indent(depth) {
  return { paddingLeft: `${8 + depth * 14}px` };
}

function sortEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
}

function errorMessage(error) {
  const text = String(error?.message || error || "读取失败");
  return text.replace(/^Runtime request failed\.$/, "读取失败");
}
