import { useState } from "react";
import { Activity, BrainCircuit, CircleGauge, Cloud, GitBranch, Goal, Server, Sparkles, X } from "lucide-react";
import { TaskPanel } from "./TaskPanel.jsx";
import { GoalPanel } from "./GoalPanel.jsx";
import { formatDuration } from "../lib/toolDisplay.js";

const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function Inspector({ info, stats, goal, plan, models, effort, connection, onModel, onEffort, onRefreshModels, onCompact, compacting, currentModel, contextInfo = null, panelAttrs = {}, panelRef, onClose, request, onGoalAction }) {
  const [tab, setTab] = useState("details");
  const [error, setError] = useState("");
  async function change(action, value) { setError(""); try { await action?.(value); } catch (cause) { setError(cause.message); } }
  // Mobile drawer wiring (master plan §6.2): panelAttrs carries the drawer
  // class and aria/inert state below the breakpoint; empty on desktop.
  const { className: panelClassName = "", ...restPanelAttrs } = panelAttrs;
  const usage = Math.min(1, Math.max(0, Number(stats?.context_usage_percent || 0)));
  const modelValue = currentModel || info?.model || info?.default_model || "";
  const modelOptions = Array.from(new Set([modelValue, ...models].filter(Boolean)));
  return <aside ref={panelRef} className={`inspector ${panelClassName}`.trim()} tabIndex={-1} {...restPanelAttrs}>
    <div className="inspector-heading"><h2>Session details</h2>{onClose && <button className="icon-button subtle" aria-label="Close session details" onClick={onClose}><X size={17} /></button>}</div>
    <div className="panel-tabs" role="tablist" aria-label="Session details"><button role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>Overview</button><button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button></div>
    {tab === "tasks" ? <TaskPanel sessionId={info.session_id} request={request} enabled={Boolean(info.capabilities?.includes?.("rind/tasks") || info.methods?.includes?.("rind/task/list"))} /> : <>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="state-list">
      <StateRow icon={<Server size={15} />} label="Connection" value={connection === "connected" ? "online" : "offline"} tone={connection === "connected" ? "success" : ""} />
      <StateRow icon={<Cloud size={15} />} label="Conversation" value={info?.session_id ? "Ready" : "New"} />
      <StateRow icon={<GitBranch size={15} />} label="Workspace" value={shortPath(info?.workspace_root)} />
    </div>
    <div className="inspector-section"><div className="section-title"><BrainCircuit size={15} /> Model</div><select aria-label="Model" value={modelValue} onFocus={onRefreshModels} onChange={(event) => change(onModel, event.target.value)}>{modelOptions.length ? modelOptions.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">Select model</option>}</select><select aria-label="Reasoning effort" value={effort || ""} onChange={(event) => change(onEffort, event.target.value)}><option value="" disabled>Reasoning effort</option>{["low", "medium", "high", "xhigh", "max"].map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
    {/* Context gauge (audit #15): ring + "tokens · % used" badge; the expandable
        detail carries window/cached plus last-turn duration & message count
        when the runtime reported them. No cost display — the kernel doesn't track $. */}
    <div className="inspector-section context-section"><div className="section-title"><CircleGauge size={15} /> Context</div>
      <div className="context-ring-row">
        <svg className="context-ring" viewBox="0 0 44 44" role="img" aria-label={`Context ${Math.round(usage * 100)}% used`}>
          <circle className="context-ring-track" cx="22" cy="22" r={RING_RADIUS} fill="none" strokeWidth="4" />
          <circle
            className={`context-ring-value ${usage > 0.9 ? "near-full" : ""}`}
            cx="22" cy="22" r={RING_RADIUS} fill="none" strokeWidth="4" strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - usage)}
            transform="rotate(-90 22 22)"
          />
        </svg>
        <div className="context-badge">
          <strong>{formatTokens(stats?.input_tokens)}</strong>
          <span>{Math.round(usage * 100)}% used</span>
        </div>
      </div>
      <details className="context-detail">
        <summary>Details</summary>
        <div className="context-detail-rows">
          <div className="tool-detail"><span>window</span><strong>{formatTokens(stats?.context_window_tokens)}</strong></div>
          <div className="tool-detail"><span>cached</span><strong>{formatTokens(stats?.cached_input_tokens)}</strong></div>
          {Number(contextInfo?.lastTurnDurationMs) > 0 && <div className="tool-detail"><span>last turn</span><strong>{formatDuration(contextInfo.lastTurnDurationMs)}</strong></div>}
          {Number(contextInfo?.messageCount) > 0 && <div className="tool-detail"><span>context messages</span><strong>{contextInfo.messageCount}</strong></div>}
        </div>
      </details>
    </div>
    <GoalPanel key={info.session_id} goal={goal} onAction={onGoalAction} disabled={!info.session_id || connection !== "connected"} />
    <div className="inspector-section"><div className="section-title"><Activity size={15} /> Actions</div><button className="secondary-action" onClick={onCompact} disabled={compacting}><Sparkles size={14} /> {compacting ? "Compacting..." : "Compact context"}</button></div>
    {plan?.length > 0 && <div className="inspector-section mini-plan"><div className="section-title"><Goal size={15} /> Current plan</div><span className="muted">{plan.filter((item) => item.status === "completed").length} of {plan.length} complete</span></div>}
    </>}
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
