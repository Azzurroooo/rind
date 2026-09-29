import { CornerUpRight, Pencil, X } from "lucide-react";

// Queue tray (spec section 6, after the Rind palette's queued rows): inputs
// queued while a turn runs sit above the composer. A follow-up can be
// promoted to steer the running turn; any entry can be pulled back into the
// draft (Edit) or dropped (Remove).
export function QueueTray({ entries, onPromote, onEdit, onRemove }) {
  if (!entries?.length) return null;
  return (
    <ul className="queue-tray" aria-label="Queued messages">
      {entries.map((entry) => {
        const steering = entry.mode === "steering";
        return (
          <li key={entry.inputId} className={`queued-row${steering ? " steering" : ""}`} data-input-id={entry.inputId}>
            <span className="queued-label">{steering ? "Steering" : "Queued"}</span>{" "}
            <span className="queued-text" dir="auto" title={entry.input}>{entry.input}</span>
            <span className="queued-actions">
              {!steering && (
                <button type="button" className="icon-button" aria-label="Promote to steer the current turn" title="Promote: steer the current turn" onClick={() => onPromote?.(entry)}>
                  <CornerUpRight size={14} aria-hidden="true" />
                </button>
              )}
              <button type="button" className="icon-button" aria-label="Edit queued message" title="Edit" onClick={() => onEdit?.(entry)}>
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" className="icon-button" aria-label="Remove queued message" title="Remove" onClick={() => onRemove?.(entry)}>
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
