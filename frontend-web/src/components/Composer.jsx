import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, Command, CornerUpRight, Layers, Paperclip, Square } from "lucide-react";
import { buildCommands, matchingSlashCommands } from "../lib/commands.js";
import { UploadChip } from "./UploadChip.jsx";
import { composeMessageWithAttachments } from "../lib/files.js";

const NOTICE_MS = 4000;
const DRAFT_HISTORY_MAX = 50;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
let nextChipId = 1;

// Composer (web-ui.md §2.4): paste / drag-drop / paperclip → attachment chips
// above the input; uploads run via the App-provided onUpload (file/write) and
// NEVER block typing or sending. On send, each uploaded chip appends a path
// reference line to the message; chips still uploading are left out and a thin
// one-line notice above the composer says so — no modal.
//
// Queue mode (audit #1, opencode pattern): while a turn runs, submissions
// queue as follow_up by default; the visible 排队追问 / 转向 switch (the web
// sibling of the CLI's Tab toggle) flips the wire method between
// rind/session/follow_up and rind/session/steer. The first Esc of a running
// turn arms the interrupt; the hint renders from App state.
//
// "/" suggestions source the SAME command registry as the palette (audit #9).
const Composer = forwardRef(function Composer({
  value,
  onChange,
  onSubmit,
  active,
  onCancel,
  disabled,
  onUpload,
  queueMode = "follow_up", // "follow_up" | "steering" (kernel vocabulary)
  onQueueModeChange,
  interruptArmed = false,
  commands = buildCommands({}),
}, ref) {
  const [chips, setChips] = useState([]);
  const [notice, setNotice] = useState("");
  const [draftHistory, setDraftHistory] = useState([]); // sent prompts, oldest first (shell ↑-recall)
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = live input
  const noticeTimer = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus();
    },
  }), []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  const patchChip = useCallback((id, patch) => {
    setChips((current) => current.map((chip) => (chip.id === id ? { ...chip, ...patch } : chip)));
  }, []);

  const removeChip = useCallback((chip) => {
    setChips((current) => current.filter((item) => item.id !== chip.id));
    if (chip.previewUrl) URL.revokeObjectURL?.(chip.previewUrl);
  }, []);

  const startUpload = useCallback((chip) => {
    if (!onUpload) return;
    patchChip(chip.id, { status: "uploading", error: "" });
    onUpload(chip.file)
      .then((path) => patchChip(chip.id, { status: "ok", path: String(path || ""), error: "" }))
      .catch((error) => patchChip(chip.id, { status: "failed", error: error instanceof Error ? error.message : String(error || "上传失败") }));
  }, [onUpload, patchChip]);

  const addFiles = useCallback((fileList) => {
    const all = Array.from(fileList || []).filter(Boolean);
    const files = all.filter((file) => file.size == null || file.size <= MAX_FILE_BYTES);
    const rejected = all.length - files.length;
    if (rejected) {
      setNotice(rejected === 1 ? "1 个文件超过 8MB，未添加" : `${rejected} 个文件超过 8MB，未添加`);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
    }
    if (!files.length) return;
    const created = files.map((file) => ({
      id: `chip-${nextChipId++}`,
      file,
      name: file.name || "pasted-image",
      size: file.size || 0,
      mime: file.type || "",
      previewUrl: previewUrlFor(file),
      status: onUpload ? "uploading" : "failed",
      path: "",
      error: onUpload ? "" : "上传不可用",
    }));
    setChips((current) => [...current, ...created]);
    for (const chip of created) {
      if (chip.status === "uploading") startUpload(chip);
    }
  }, [onUpload, startUpload]);

  function sendMessage() {
    if (disabled) return;
    const current = chipsRef.current;
    const uploading = current.filter((chip) => chip.status === "uploading");
    const sentPaths = current.filter((chip) => chip.status === "ok" && chip.path).map((chip) => chip.path);
    const composed = composeMessageWithAttachments(value, sentPaths);
    onSubmit?.(composed);
    if (value.trim()) {
      setDraftHistory((history) => [...history.slice(-(DRAFT_HISTORY_MAX - 1)), value]);
      setHistoryIndex(-1);
    }
    // Delivered chips leave the row; still-uploading chips stay for the next message.
    const delivered = new Set(current.filter((chip) => chip.status === "ok" && chip.path).map((chip) => chip.id));
    setChips((next) => next.filter((chip) => !delivered.has(chip.id)));
    if (uploading.length) {
      setNotice(uploading.length === 1 ? "1 个附件仍在上传，未随消息发送" : `${uploading.length} 个附件仍在上传，未随消息发送`);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
    }
  }

  // Shell-style ↑/↓ recall of sent prompts: only an empty input starts a
  // navigation (caret-safe); ↓ past the newest entry returns to the live draft.
  function navigateHistory(direction) {
    if (!draftHistory.length) return;
    if (historyIndex === -1) {
      if (direction !== "up") return;
      const last = draftHistory.length - 1;
      setHistoryIndex(last);
      onChange(draftHistory[last]);
      return;
    }
    const next = direction === "up" ? historyIndex - 1 : historyIndex + 1;
    if (next < 0) return; // already at the oldest
    if (next >= draftHistory.length) {
      setHistoryIndex(-1);
      onChange("");
      return;
    }
    setHistoryIndex(next);
    onChange(draftHistory[next]);
  }

  const commandMode = value.startsWith("/");
  const query = value.slice(1).split(/\s/)[0].toLowerCase();
  const suggestions = commandMode && !value.includes(" ")
    ? matchingSlashCommands(commands, query)
    : [];

  return (
    <div className="composer-wrap">
      {notice && <div className="upload-notice" role="status">{notice}</div>}
      <div
        className="composer-shell"
        onDragOver={(event) => {
          if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer?.files?.length) {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }
        }}
      >
        {suggestions.length > 0 && (
          <div className="slash-suggestions">
            {suggestions.map((command) => (
              <button key={command.id} onClick={() => onChange(`/${command.slash} `)}>
                <Command size={14} /><strong>/{command.slash}</strong><span>{command.title}</span>
              </button>
            ))}
          </div>
        )}
        {chips.length > 0 && (
          <div className="chip-row" aria-label="附件">
            {chips.map((chip) => (
              <UploadChip key={chip.id} chip={chip} onDelete={removeChip} onRetry={startUpload} />
            ))}
          </div>
        )}
        {interruptArmed && <div className="interrupt-hint" role="status">再按一次 Esc 停止</div>}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
              return;
            }
            if (event.key === "ArrowUp" && (value === "" || historyIndex !== -1)) {
              event.preventDefault();
              navigateHistory("up");
              return;
            }
            if (event.key === "ArrowDown" && historyIndex !== -1) {
              event.preventDefault();
              navigateHistory("down");
            }
          }}
          onPaste={(event) => {
            if (event.clipboardData?.files?.length) {
              event.preventDefault();
              addFiles(event.clipboardData.files);
            }
          }}
          placeholder={active ? (queueMode === "steering" ? "立即转向当前回合（steer）…" : "回合进行中，消息将排队追问…") : "Ask your worker anything..."}
          disabled={disabled}
          rows={1}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <input ref={fileInputRef} type="file" multiple className="visually-hidden" aria-hidden="true" tabIndex={-1} onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            <button className="icon-button subtle" title="添加附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
            {active && (
              <span className="queue-toggle" role="group" aria-label="队列模式">
                <button
                  type="button"
                  className={queueMode === "follow_up" ? "selected" : ""}
                  aria-pressed={queueMode === "follow_up"}
                  title="回合结束后排队追问（follow_up）"
                  onClick={() => onQueueModeChange?.("follow_up")}
                ><Layers size={13} /> 排队追问</button>
                <button
                  type="button"
                  className={queueMode === "steering" ? "selected" : ""}
                  aria-pressed={queueMode === "steering"}
                  title="立即插入当前回合（steer）"
                  onClick={() => onQueueModeChange?.("steering")}
                ><CornerUpRight size={13} /> 转向 steer</button>
              </span>
            )}
            <span>Enter 发送 · Shift+Enter 换行 · ↑ 召回最近消息</span>
          </div>
          {active
            ? <button className="send-button stop" title={interruptArmed ? "再按一次 Esc 停止" : "Stop active turn"} onClick={onCancel}><Square size={15} fill="currentColor" /></button>
            : <button className="send-button" title="Send message" onClick={() => sendMessage()} disabled={(!value.trim() && !chips.some((chip) => chip.status === "ok" && chip.path)) || disabled}><ArrowUp size={18} /></button>}
        </div>
      </div>
      <div className="composer-status"><span><span className="status-led" />{active ? "Turn in progress" : "Ready"}</span><span>Worker remains online when this tab closes</span></div>
    </div>
  );
});

function previewUrlFor(file) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
  try {
    return file.type?.startsWith("image/") ? URL.createObjectURL(file) : "";
  } catch {
    return "";
  }
}

export { Composer };
export default Composer;
