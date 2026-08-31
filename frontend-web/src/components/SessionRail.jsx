import { Check, ChevronRight, CirclePlus, FolderOpen, History, LoaderCircle, MessageSquareText } from "lucide-react";
import { sessionIdOf } from "../methods.js";

export function SessionRail({ sessions, activeId, loading, workspace, workspaceDraft, workspaceBusy, workspaceMessage, onWorkspaceDraftChange, onWorkspaceApply, onNew, onSelect }) {
  return (
    <aside className="session-rail">
      <div className="rail-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h2>Choose a directory</h2>
        </div>
        <button className="icon-button" title="New session in selected workspace" onClick={onNew} disabled={!workspace}><CirclePlus size={18} /></button>
      </div>
      <div className="workspace-picker">
        <label htmlFor="workspace-path">Selected directory</label>
        <div className="workspace-input-row"><FolderOpen size={15} /><input id="workspace-path" value={workspaceDraft} onChange={(event) => onWorkspaceDraftChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onWorkspaceApply()} placeholder="E:\\projects\\rind" /><button className="icon-button subtle" title="Use selected directory" onClick={onWorkspaceApply} disabled={workspaceBusy || !workspaceDraft.trim()}>{workspaceBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</button></div>
        {workspaceMessage ? <div className="workspace-message">{workspaceMessage}</div> : <div className="workspace-hint">{workspace || "Choose the worker-visible path"}</div>}
      </div>
      <div className="rail-rule" />
      <div className="sessions-heading"><span>Sessions</span><span>{sessions.length}</span></div>
      {loading ? <div className="rail-empty"><LoaderCircle className="spin" size={16} /> Loading sessions</div> : sessions.length ? (
        <nav className="session-list" aria-label="Sessions">
          {sessions.map((session) => {
            const id = sessionIdOf(session);
            const current = id === activeId;
            return <button key={id} className={`session-item ${current ? "selected" : ""}`} onClick={() => onSelect(id)}>
              <MessageSquareText size={16} />
              <span className="session-copy"><strong>{session.title || session.preview || "Untitled session"}</strong><small>{session.updated_at || id}</small></span>
              {current && <ChevronRight size={15} className="selected-arrow" />}
            </button>;
          })}
        </nav>
      ) : <div className="rail-empty"><History size={16} /> No sessions yet</div>}
      <div className="rail-footer">Long-lived worker · browser-safe disconnect</div>
    </aside>
  );
}
