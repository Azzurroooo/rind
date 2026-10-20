import { Folder } from "lucide-react";

export function ComposerContext({ workspace, agentContext, active, compacting, awaitingAnswer, interruptArmed }) {
  const isAgentScoped = agentContext?.kind === "member" || agentContext?.kind === "manager";
  const effectiveWorkspace = (isAgentScoped && agentContext?.workspaceRoot) || workspace || "";
  const name = String(effectiveWorkspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const scopeLabel =
    agentContext?.kind === "manager"
      ? "Manager"
      : agentContext?.kind === "member"
        ? `${agentContext.teamName} / ${agentContext.agentName}`
        : "";
  const status = interruptArmed ? "Esc again to stop" : compacting ? "Compacting" : awaitingAnswer ? "Your input needed" : active ? "Working" : "Ready";
  return (
    <div className="composer-context">
      <details className={`workspace-hint${isAgentScoped ? " is-agent-locked" : ""}`}>
        <summary title={effectiveWorkspace || "Working folder"} aria-label={`Working folder: ${effectiveWorkspace || "not selected"}`}>
          <Folder size={13} aria-hidden="true" />
          {scopeLabel ? <span className="composer-project-scope">{scopeLabel}</span> : null}
          <span>{(isAgentScoped ? effectiveWorkspace : name) || "Working folder"}</span>
        </summary>
        <div className="workspace-detail">
          <span>{isAgentScoped ? `Locked to ${scopeLabel} workspace` : "Folder on Rind computer"}</span>
          <code>{effectiveWorkspace || "Select a project to get started."}</code>
        </div>
      </details>
      <span className={`composer-activity${active || compacting ? " is-active" : ""}${interruptArmed ? " interrupt-hint" : ""}`} role="status">
        <span className="activity-motion" aria-hidden="true"><i /><i /><i /></span><span>{status}</span>
      </span>
    </div>
  );
}
