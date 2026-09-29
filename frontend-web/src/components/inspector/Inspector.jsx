import { useRef } from "react";
import { X } from "lucide-react";
import { TaskPanel } from "../TaskPanel.jsx";
import { GoalPanel } from "../GoalPanel.jsx";
import { FileTree } from "../FileTree.jsx";
import { methods } from "../../methods.js";
import { ContextTab } from "./ContextTab.jsx";
import { UsageTab } from "./UsageTab.jsx";
import { BackgroundList } from "./BackgroundList.jsx";

const TAB_LABELS = Object.freeze({ context: "Context", tasks: "Tasks", files: "Files", goal: "Goal", usage: "Usage" });

// Which tabs the connected runtime can back. Tasks and Usage only appear when
// the runtime advertises their methods.
export function visibleTabs(info) {
  const available = new Set(info?.methods || []);
  const capabilities = new Set(info?.capabilities || []);
  const tasks = available.has(methods.taskList) || capabilities.has("rind/tasks");
  const background = available.has(methods.backgroundList);
  return {
    tabs: [
      "context",
      ...(tasks || background ? ["tasks"] : []),
      "files",
      "goal",
      ...(available.has(methods.usageSummary) || available.has(methods.authList) ? ["usage"] : []),
    ],
    tasks,
    background,
    usage: available.has(methods.usageSummary),
    auth: available.has(methods.authList),
  };
}

// Inspector (spec section 2), after LobeHub's right panel: a 360px column of
// tabs (Context, Tasks, Files, Goal, Usage). Tabs follow the WAI-ARIA tabs
// pattern with roving arrow keys.
export function Inspector({
  tab,
  onTab,
  onClose,
  info,
  stats,
  contextSnapshot,
  contextInfo,
  goal,
  connected,
  compacting,
  onCompact,
  onGoalAction,
  request,
  workspace,
  listFiles,
  readFile,
  fileRequest,
  panelRef,
  panelAttrs = {},
  style,
}) {
  const gates = visibleTabs(info);
  const current = gates.tabs.includes(tab) ? tab : gates.tabs[0];
  const tabRefs = useRef({});
  const sessionId = info?.session_id || "";

  function onTabKey(event) {
    const index = gates.tabs.indexOf(current);
    const moves = { ArrowRight: 1, ArrowLeft: -1 };
    let next = null;
    if (event.key in moves) next = gates.tabs[(index + moves[event.key] + gates.tabs.length) % gates.tabs.length];
    if (event.key === "Home") next = gates.tabs[0];
    if (event.key === "End") next = gates.tabs[gates.tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    onTab?.(next);
    tabRefs.current[next]?.focus();
  }

  const { className = "", ...attrs } = panelAttrs;

  return (
    <aside ref={panelRef} id="inspector-panel" className={`inspector ${className}`.trim()} tabIndex={-1} aria-label="Inspector" style={style} {...attrs}>
      <div className="inspector-head">
        <div className="inspector-tabs" role="tablist" aria-label="Inspector sections" onKeyDown={onTabKey}>
          {gates.tabs.map((name) => (
            <button
              key={name}
              ref={(node) => { tabRefs.current[name] = node; }}
              type="button"
              role="tab"
              id={`inspector-tab-${name}`}
              aria-selected={name === current}
              aria-controls="inspector-tabpanel"
              tabIndex={name === current ? 0 : -1}
              className="inspector-tab"
              onClick={() => onTab?.(name)}
            >
              {TAB_LABELS[name]}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="inspector-panel" role="tabpanel" id="inspector-tabpanel" aria-labelledby={`inspector-tab-${current}`}>
        {current === "context" && (
          <ContextTab stats={stats} snapshot={contextSnapshot} contextInfo={contextInfo} compacting={compacting} canCompact={Boolean(sessionId)} onCompact={onCompact} />
        )}
        {current === "tasks" && (
          <div className="inspector-body">
            {gates.tasks
              ? <TaskPanel sessionId={sessionId} request={request} enabled />
              : <BackgroundList sessionId={sessionId} request={request} />}
          </div>
        )}
        {current === "files" && (
          <div className="inspector-body files-tab">
            <FileTree key={workspace || "none"} workspace={workspace} listFiles={listFiles} readFile={readFile} embedded openRequest={fileRequest} />
          </div>
        )}
        {current === "goal" && (
          <div className="inspector-body">
            <GoalPanel key={sessionId} goal={goal} onAction={onGoalAction} disabled={!sessionId || !connected} />
          </div>
        )}
        {current === "usage" && <UsageTab request={request} usageEnabled={gates.usage} authEnabled={gates.auth} />}
      </div>
    </aside>
  );
}
