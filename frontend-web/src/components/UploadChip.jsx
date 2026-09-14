import { Check, FileText, LoaderCircle, RotateCw, X } from "lucide-react";
import { formatBytes, isImageMime } from "../lib/files.js";

// One attachment chip (web-ui.md §2.4):
//   idle → uploading → ok | failed
// failed → red + retry; delete available in EVERY state; the chip never blocks
// the text input. 48px thumbnail for images, icon for anything else.
export function UploadChip({ chip, onDelete, onRetry }) {
  const status = chip?.status || "uploading";
  const failed = status === "failed";
  const image = isImageMime(chip?.mime) && chip?.previewUrl;
  return (
    <div className={`upload-chip ${status}`} data-status={status} title={chip?.error || chip?.path || chip?.name}>
      <span className="chip-thumb" aria-hidden="true">
        {image ? <img src={chip.previewUrl} alt="" /> : <FileText size={18} />}
        {status === "uploading" && <span className="chip-thumb-veil"><LoaderCircle className="spin" size={14} /></span>}
        {status === "ok" && <span className="chip-thumb-veil ok"><Check size={14} /></span>}
      </span>
      <span className="chip-copy">
        <strong>{chip?.name || "attachment"}</strong>
        <small>
          {formatBytes(chip?.size)}
          {status === "uploading" && " · uploading"}
          {status === "ok" && chip?.path && ` · ${chip.path}`}
          {failed && chip?.error ? ` · ${chip.error}` : failed ? " · upload failed" : ""}
        </small>
      </span>
      <span className="chip-actions">
        {failed && onRetry && (
          <button type="button" className="chip-retry" title="Retry upload" aria-label={`Retry upload ${chip?.name || ""}`} onClick={() => onRetry(chip)}>
            <RotateCw size={13} />
          </button>
        )}
        {onDelete && (
          <button type="button" className="chip-delete" title="Remove attachment" aria-label={`Remove attachment ${chip?.name || ""}`} onClick={() => onDelete(chip)}>
            <X size={13} />
          </button>
        )}
      </span>
    </div>
  );
}
