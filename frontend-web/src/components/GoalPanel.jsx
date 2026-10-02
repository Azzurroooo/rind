import { useState } from "react";

// Activity only manages an existing goal. New objectives come from /goal.
export function GoalPanel({ goal, onAction, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(value) {
    setBusy(true); setError("");
    try { await onAction?.(value); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  if (!goal?.objective) return null;
  return <>
      <p className="goal-text">{goal.objective}</p>
      <span className={`goal-status ${goal.status}`}>{goal.status}</span>
      <div className="panel-actions">
        <button disabled={busy || disabled} onClick={() => run({ type: goal.status === "active" ? "pause" : "resume" })}>{goal.status === "active" ? "Pause" : "Resume"}</button>
        <button disabled={busy || disabled} onClick={() => run({ type: "clear" })}>Clear goal</button>
      </div>
      {goal.status !== "active" && <p className="muted section-hint">Resuming lets Rind continue working automatically.</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </>;
}
