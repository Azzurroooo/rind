import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Command, Paperclip, Square } from "lucide-react";
import { slashCommands } from "../methods.js";
import { UploadChip } from "./UploadChip.jsx";
import { composeMessageWithAttachments } from "../lib/files.js";

const NOTICE_MS = 4000;
let nextChipId = 1;

// Composer (web-ui.md §2.4): paste / drag-drop / paperclip → attachment chips
// above the input; uploads run via the App-provided onUpload (file/write) and
// NEVER block typing or sending. On send, each uploaded chip appends a path
// reference line to the message; chips still uploading are left out and a thin
// one-line notice above the composer says so — no modal.
export function Composer({ value, onChange, onSubmit, active, onCancel, disabled, onUpload }) {
  const [chips, setChips] = useState([]);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(null);
  const fileInputRef = useRef(null);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;

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
    const files = Array.from(fileList || []).filter((file) => file && (file.size == null || file.size <= 8 * 1024 * 1024));
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
    // Delivered chips leave the row; still-uploading chips stay for the next message.
    const delivered = new Set(current.filter((chip) => chip.status === "ok" && chip.path).map((chip) => chip.id));
    setChips((next) => next.filter((chip) => !delivered.has(chip.id)));
    if (uploading.length) {
      setNotice(uploading.length === 1 ? "1 个附件仍在上传，未随消息发送" : `${uploading.length} 个附件仍在上传，未随消息发送`);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
    }
  }

  const commandMode = value.startsWith("/");
  const query = value.slice(1).split(/\s/)[0].toLowerCase();
  const suggestions = commandMode && !value.includes(" ") ? slashCommands.filter(([name]) => name.startsWith(query)).slice(0, 5) : [];

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
            {suggestions.map(([name, description]) => (
              <button key={name} onClick={() => onChange(`/${name} `)}><Command size={14} /><strong>/{name}</strong><span>{description}</span></button>
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
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
            }
          }}
          onPaste={(event) => {
            if (event.clipboardData?.files?.length) {
              event.preventDefault();
              addFiles(event.clipboardData.files);
            }
          }}
          placeholder={active ? "Send steering input to the active turn..." : "Ask your worker anything..."}
          disabled={disabled}
          rows={1}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <input ref={fileInputRef} type="file" multiple className="visually-hidden" aria-hidden="true" tabIndex={-1} onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            <button className="icon-button subtle" title="添加附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
            <span>Enter to send · Shift+Enter for new line</span>
          </div>
          {active
            ? <button className="send-button stop" title="Stop active turn" onClick={onCancel}><Square size={15} fill="currentColor" /></button>
            : <button className="send-button" title="Send message" onClick={() => sendMessage()} disabled={(!value.trim() && !chips.some((chip) => chip.status === "ok" && chip.path)) || disabled}><ArrowUp size={18} /></button>}
        </div>
      </div>
      <div className="composer-status"><span><span className="status-led" />{active ? "Turn in progress" : "Ready"}</span><span>Worker remains online when this tab closes</span></div>
    </div>
  );
}

function previewUrlFor(file) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
  try {
    return file.type?.startsWith("image/") ? URL.createObjectURL(file) : "";
  } catch {
    return "";
  }
}
