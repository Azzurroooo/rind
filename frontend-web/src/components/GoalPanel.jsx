import { useState } from "react";
import { Goal } from "lucide-react";

export function GoalPanel({ goal, onAction, disabled }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(value) {
    setBusy(true); setError("");
    try { await onAction?.(value); setDraft(""); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <section className="inspector-section goal-section" tabIndex={-1}><div className="section-title"><Goal size={15} /> Goal</div>
    {goal?.objective ? <><p className="goal-text">{goal.objective}</p><span className={`goal-status ${goal.status}`}>{goal.status}</span><div className="panel-actions"><button disabled={busy || disabled} onClick={() => run({ type: goal.status === "active" ? "pause" : "resume" })}>{goal.status === "active" ? "Pause" : "Resume"}</button><button disabled={busy || disabled} onClick={() => run({ type: "clear" })}>Clear goal</button></div>{goal.status !== "active" && <p className="muted">Resuming lets Rind continue working automatically.</p>}</> : <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void run({ type: "start", objective: draft.trim() }); }}><textarea aria-label="Goal objective" placeholder="What should Rind work toward?" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} /><p className="muted">Starting a goal lets Rind continue working automatically.</p><button className="secondary-action" disabled={busy || disabled || !draft.trim()}>{busy ? "Starting…" : "Start goal"}</button></form>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}
