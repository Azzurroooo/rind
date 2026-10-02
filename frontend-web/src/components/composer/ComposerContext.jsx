import { Folder } from "lucide-react";

export function ComposerContext({ workspace, active, compacting, awaitingAnswer, interruptArmed }) {
  const name = String(workspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const status = interruptArmed ? "Esc again to stop" : compacting ? "Compacting" : awaitingAnswer ? "Your input needed" : active ? "Working" : "Ready";
  return (
    <div className="composer-context">
      <details className="workspace-hint">
        <summary title={workspace || "Working folder"} aria-label={`Working folder: ${workspace || "not selected"}`}><Folder size={13} aria-hidden="true" /><span>{name || "Working folder"}</span></summary>
        <div className="workspace-detail"><span>Folder on Rind computer</span><code>{workspace || "Select a project to get started."}</code></div>
      </details>
      <span className={`composer-activity${active || compacting ? " is-active" : ""}${interruptArmed ? " interrupt-hint" : ""}`} role="status">
        <span className="activity-motion" aria-hidden="true"><i /><i /><i /></span><span>{status}</span>
      </span>
    </div>
  );
}
