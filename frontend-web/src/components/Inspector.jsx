import { Activity, BrainCircuit, CircleGauge, Cloud, GitBranch, Goal, Server, Sparkles } from "lucide-react";

export function Inspector({ info, stats, goal, plan, models, effort, connection, onModel, onEffort, onRefreshModels, onCompact, compacting, currentModel }) {
  const usage = Number(stats?.context_usage_percent || 0);
  const modelValue = currentModel || info?.model || info?.default_model || "";
  const modelOptions = Array.from(new Set([modelValue, ...models].filter(Boolean)));
  return <aside className="inspector">
    <div className="inspector-heading"><div><span className="eyebrow">RUNTIME</span><h2>Session state</h2></div><span className="live-pulse" /></div>
    <div className="state-list">
      <StateRow icon={<Server size={15} />} label="Worker" value={connection === "connected" ? "online" : "offline"} tone={connection === "connected" ? "success" : ""} />
      <StateRow icon={<Cloud size={15} />} label="Session" value={info?.session_id || "none"} />
      <StateRow icon={<GitBranch size={15} />} label="Workspace" value={shortPath(info?.workspace_root)} />
    </div>
    <div className="inspector-section"><div className="section-title"><BrainCircuit size={15} /> Model</div><select value={modelValue} onFocus={onRefreshModels} onChange={(event) => onModel(event.target.value)}>{modelOptions.length ? modelOptions.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">Select model</option>}</select><select value={effort || ""} onChange={(event) => onEffort(event.target.value)}><option value="">Reasoning effort</option>{["low", "medium", "high", "xhigh", "max"].map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
    <div className="inspector-section"><div className="section-title"><CircleGauge size={15} /> Context</div><div className="usage-value"><strong>{formatTokens(stats?.input_tokens)}</strong><span>{formatTokens(stats?.context_window_tokens)} window</span></div><div className="usage-track"><span style={{ width: `${Math.min(100, usage * 100)}%` }} /></div><div className="usage-foot"><span>{Math.round(usage * 100)}% used</span><span>{formatTokens(stats?.cached_input_tokens)} cached</span></div></div>
    <div className="inspector-section goal-section"><div className="section-title"><Goal size={15} /> Goal</div>{goal?.objective ? <><strong className="goal-text">{goal.objective}</strong><span className={`goal-status ${goal.status}`}>{goal.status}</span></> : <span className="muted">No active goal</span>}</div>
    <div className="inspector-section"><div className="section-title"><Activity size={15} /> Actions</div><button className="secondary-action" onClick={onCompact} disabled={compacting}><Sparkles size={14} /> {compacting ? "Compacting..." : "Compact context"}</button></div>
    {plan?.length > 0 && <div className="inspector-section mini-plan"><div className="section-title"><Goal size={15} /> Current plan</div><span className="muted">{plan.filter((item) => item.status === "completed").length} of {plan.length} complete</span></div>}
  </aside>;
}

function StateRow({ icon, label, value, tone }) {
  return <div className="state-row"><span className="state-icon">{icon}</span><span>{label}</span><strong className={tone || ""}>{value}</strong></div>;
}

function shortPath(value) {
  const text = String(value || "not reported");
  return text.length > 27 ? `...${text.slice(-24)}` : text;
}

function formatTokens(value) {
  const number = Number(value || 0);
  if (!number) return "0";
  return number > 999 ? `${(number / 1000).toFixed(number > 99999 ? 0 : 1)}k` : String(number);
}
