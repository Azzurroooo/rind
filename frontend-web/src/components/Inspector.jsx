import { Activity, BrainCircuit, CircleGauge, Cloud, GitBranch, Goal, Server, Sparkles } from "lucide-react";
import { formatDuration } from "../lib/toolDisplay.js";

const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function Inspector({ info, stats, goal, plan, models, effort, connection, onModel, onEffort, onRefreshModels, onCompact, compacting, currentModel, contextInfo = null, panelAttrs = {}, panelRef }) {
  // Mobile drawer wiring (master plan §6.2): panelAttrs carries the drawer
  // class and aria/inert state below the breakpoint; empty on desktop.
  const { className: panelClassName = "", ...restPanelAttrs } = panelAttrs;
  const usage = Math.min(1, Math.max(0, Number(stats?.context_usage_percent || 0)));
  // crush-style tiers: the meter only speaks when it matters — past 75% the
  // badge turns amber ("收窄回答/可压缩"), past 90% red ("接近上限，建议压缩").
  const usageTone = usage > 0.9 ? "near-full" : usage > 0.75 ? "high" : "";
  const usageHint = usage > 0.9 ? "接近上限 · 建议 Compact" : usage > 0.75 ? "偏高 · 可 Compact 腾出空间" : "";
  const modelValue = currentModel || info?.model || info?.default_model || "";
  const modelOptions = Array.from(new Set([modelValue, ...models].filter(Boolean)));
  return <aside ref={panelRef} className={`inspector ${panelClassName}`.trim()} tabIndex={-1} {...restPanelAttrs}>
    <div className="inspector-heading"><div><span className="eyebrow">RUNTIME</span><h2>Session state</h2></div><span className="live-pulse" /></div>
    <div className="state-list">
      <StateRow icon={<Server size={15} />} label="Worker" value={connection === "connected" ? "online" : "offline"} tone={connection === "connected" ? "success" : ""} />
      <StateRow icon={<Cloud size={15} />} label="Session" value={info?.session_id || "none"} />
      <StateRow icon={<GitBranch size={15} />} label="Workspace" value={shortPath(info?.workspace_root)} />
    </div>
    <div className="inspector-section"><div className="section-title"><BrainCircuit size={15} /> Model</div><select value={modelValue} onFocus={onRefreshModels} onChange={(event) => onModel(event.target.value)}>{modelOptions.length ? modelOptions.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">Select model</option>}</select><select value={effort || ""} onChange={(event) => onEffort(event.target.value)}><option value="">Reasoning effort</option>{["low", "medium", "high", "xhigh", "max"].map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
    {/* Context gauge (audit #15): ring + "tokens · % used" badge; the expandable
        detail carries window/cached plus last-turn duration & message count
        when the runtime reported them. No cost display — the kernel doesn't track $. */}
    <div className="inspector-section context-section"><div className="section-title"><CircleGauge size={15} /> Context</div>
      <div className="context-ring-row">
        <svg className="context-ring" viewBox="0 0 44 44" role="img" aria-label={`上下文已使用 ${Math.round(usage * 100)}%`}>
          <circle className="context-ring-track" cx="22" cy="22" r={RING_RADIUS} fill="none" strokeWidth="4" />
          <circle
            className={`context-ring-value ${usageTone}`}
            cx="22" cy="22" r={RING_RADIUS} fill="none" strokeWidth="4" strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - usage)}
            transform="rotate(-90 22 22)"
          />
        </svg>
        <div className="context-badge">
          <strong>{formatTokens(stats?.input_tokens)}</strong>
          <span className={usageTone}>{Math.round(usage * 100)}% used</span>
          {usageHint && <em>{usageHint}</em>}
        </div>
      </div>
      <details className="context-detail">
        <summary>详情</summary>
        <div className="context-detail-rows">
          <div className="tool-detail"><span>window</span><strong>{formatTokens(stats?.context_window_tokens)}</strong></div>
          <div className="tool-detail"><span>cached</span><strong>{formatTokens(stats?.cached_input_tokens)}</strong></div>
          {Number(contextInfo?.lastTurnDurationMs) > 0 && <div className="tool-detail"><span>上一回合</span><strong>{formatDuration(contextInfo.lastTurnDurationMs)}</strong></div>}
          {Number(contextInfo?.messageCount) > 0 && <div className="tool-detail"><span>上下文消息</span><strong>{contextInfo.messageCount} 条</strong></div>}
        </div>
      </details>
    </div>
    <div className="inspector-section goal-section" tabIndex={-1}><div className="section-title"><Goal size={15} /> Goal</div>{goal?.objective ? <><strong className="goal-text">{goal.objective}</strong><span className={`goal-status ${goal.status}`}>{goal.status}</span></> : <span className="muted">No active goal</span>}</div>
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
