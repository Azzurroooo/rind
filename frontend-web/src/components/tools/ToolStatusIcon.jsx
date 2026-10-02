import { Ban, Check, Hand, LoaderCircle, X } from "lucide-react";

const LABELS = {
  running: "Running",
  success: "Done",
  error: "Failed",
  waiting: "Waiting on you",
  cancelled: "Cancelled",
};

// Status glyph for a call row or a fold header (spec 5.2): spinner, check,
// x in --danger, hand in --info, ban in --dim. The label is for screen readers.
export function ToolStatusIcon({ status }) {
  const icon = {
    running: <LoaderCircle size={14} className="spin" aria-hidden="true" />,
    error: <X size={14} aria-hidden="true" />,
    waiting: <Hand size={14} aria-hidden="true" />,
    cancelled: <Ban size={14} aria-hidden="true" />,
  }[status] || <Check size={14} aria-hidden="true" />;
  return (
    <span className={`tool-status-icon is-${status || "success"}`}>
      {icon}
      <span className="visually-hidden">{LABELS[status] || LABELS.success}</span>
    </span>
  );
}
