import { useState } from "react";
import { UsageDialog } from "../components/inspector/UsageDialog.jsx";
import { LoginGate } from "../components/LoginGate.jsx";
import { CommandPalette } from "../components/CommandPalette.jsx";
import { ConnectionStrip } from "../components/shell/ConnectionStrip.jsx";
import { Sidebar } from "../components/shell/Sidebar.jsx";
import { ChatHeader, headerMenuItems } from "../components/shell/ChatHeader.jsx";
import { ResizeHandle } from "../components/shell/ResizeHandle.jsx";
import { Conversation } from "../components/conversation/Conversation.jsx";
import { Composer } from "../components/composer/Composer.jsx";
import { Inspector, visibleTabs } from "../components/inspector/Inspector.jsx";
import { SettingsDialog } from "../components/settings/SettingsDialog.jsx";
import { TeamView } from "../components/agents/TeamView.jsx";
import { InboxView } from "../components/agents/InboxView.jsx";
import { BackgroundView } from "../components/agents/BackgroundView.jsx";
import { methods } from "../methods.js";
import { INSPECTOR_WIDTH, SIDEBAR_WIDTH } from "./constants.js";
import { useAppController } from "./useAppController.js";
import { headerStatus, lastUserPrompt, panelAttrs, sessionTitle } from "./shellModel.js";

// The v2 shell (spec section 2): sidebar | header + center-stage surface |
// inspector. Below 768px the side panels become exclusive drawers over a scrim.
export function Shell() {
  const [usageOpen, setUsageOpen] = useState(false);
  const { ctx, actions, view, agents, request, fileRequest, openFile } = useAppController();
  const { layout, info, connection, refs } = ctx;

  if (connection.phase === "login") {
    return <LoginGate onSubmit={actions.handleLogin} busy={ctx.authBusy} error={connection.message} initialToken={ctx.loginToken} />;
  }

  const sessionId = info.session_id || "";
  const compacting = ctx.compacting || ctx.conversation.operation === "compact";
  const available = info.methods || [];
  const canFork = available.includes(methods.sessionFork);
  const hasTeams = Boolean(
    agents.snapshot.teams.length > 0 ||
      agents.activeSessionContext.kind === "manager" ||
      agents.activeSessionContext.kind === "member",
  );
  const tabs = visibleTabs(info, { hasTeam: hasTeams });
  const connected = connection.phase === "online" || connection.phase === "syncing";
  const drawerOpen = layout.narrow && Boolean(layout.drawer);
  const isChatSurface = agents.surface.kind === "chat";

  const activeHeaderTitle =
    agents.surface.kind === "inbox"
      ? "Inbox & Triage"
      : agents.surface.kind === "background"
        ? "Background & Runtime"
        : agents.surface.kind === "team"
          ? agents.currentTeamSummary?.team?.name || "Team"
          : sessionTitle(ctx.sessions, sessionId);

  function guardedFork(beforeMessageId) {
    void actions.forkSession(sessionId, beforeMessageId || "");
  }

  return (
    <div className={`app-shell${layout.narrow ? " is-narrow" : ""}`}>
      <ConnectionStrip phase={connection.phase} syncRemaining={connection.syncRemaining} syncTotal={connection.syncTotal} onReconnect={actions.reconnect} />
      {drawerOpen && <div className="drawer-backdrop" onClick={layout.closeDrawers} aria-hidden="true" />}
      <div className="shell-grid">
        <Sidebar
          sessions={ctx.sessions}
          activeId={sessionId}
          unreadIds={ctx.unreadIds}
          runningIds={ctx.runningIds}
          hasMore={ctx.hasMoreSessions}
          project={{
            workspace: ctx.selectedWorkspace,
            workspaces: ctx.workspaces,
            busy: ctx.workspaceBusy,
            message: ctx.workspaceMessage,
            draft: ctx.workspaceDraft,
            onDraftChange: ctx.setWorkspaceDraft,
            onSelect: (path) => {
              agents.clearAgentOverride();
              agents.openChatSurface();
              void actions.selectWorkspace(path);
            },
          }}
          agents={{
            snapshot: agents.snapshot,
            surface: agents.surface,
            activeSessionContext: agents.activeSessionContext,
            inboxCount: agents.inboxCount,
            bgCount: agents.bgCount,
            busy: agents.busy,
            onOpenInbox: agents.openInbox,
            onOpenManager: () => void agents.openAgentConversation({ manager: true }),
            onOpenBackground: agents.openBackground,
            onOpenTeam: agents.openTeam,
            onOpenMemberChat: (target) => void agents.openAgentConversation(target),
            onCreateTeam: async (name) => {
              const created = await agents.runAction("createTeam", { name }, `Created team "${name}"`);
              if (created?.id) agents.openTeam(created.id, "organization");
            },
          }}
          canFork={canFork}
          canExport
          notificationPermission={ctx.notificationPermission}
          onNew={() => {
            agents.clearAgentOverride();
            agents.openChatSurface();
            void actions.createSession();
          }}
          onSelect={(id) => {
            agents.clearAgentOverride();
            agents.openChatSurface();
            void actions.handleSelectSession(id);
          }}
          onFork={(id) => void actions.forkSession(id, "")}
          onExport={(id) => void actions.exportSession(id)}
          onDelete={actions.deleteSession}
          onLoadMore={actions.loadMoreSessions}
          onEnableNotifications={actions.enableNotifications}
          onOpenSettings={() => ctx.setSettingsOpen(true)}
          onOpenUsage={tabs.usage || tabs.auth ? () => setUsageOpen(true) : undefined}
          panelRef={layout.sidebarPanelRef}
          panelAttrs={panelAttrs({ narrow: layout.narrow, visible: layout.sidebarVisible })}
          style={layout.narrow ? undefined : { width: layout.sidebarWidth }}
        />
        {!layout.narrow && layout.sidebarVisible && (
          <ResizeHandle label="Resize sidebar" width={layout.sidebarWidth} min={SIDEBAR_WIDTH.min} max={SIDEBAR_WIDTH.max} edge="end" onResize={layout.setSidebarWidth} />
        )}
        <main className="main-column" aria-busy={ctx.busySession}>
          <ChatHeader
            title={activeHeaderTitle}
            status={headerStatus({ phase: connection.phase, active: view.active, compacting, waitingCount: view.backgroundWait?.count })}
            agentContext={agents.activeSessionContext}
            surface={agents.surface}
            sidebarExpanded={layout.sidebarVisible}
            inspectorExpanded={layout.inspectorVisible}
            sidebarToggleRef={layout.sidebarToggleRef}
            inspectorToggleRef={layout.inspectorToggleRef}
            showTasks={tabs.tabs.includes("activity")}
            menuItems={headerMenuItems({
              hasSession: Boolean(sessionId),
              active: view.active,
              canFork,
              compacting,
              onPalette: () => ctx.setPaletteOpen(true),
              onFork: () => guardedFork(""),
              onExport: () => void actions.exportSession(sessionId),
              onCompact: () => void actions.compact(),
            })}
            onToggleSidebar={layout.toggleSidebar}
            onToggleInspector={layout.toggleInspector}
            onOpenTasks={() => layout.openInspector("activity")}
            onOpenTeam={agents.openTeam}
            onBackToChat={agents.openChatSurface}
          />
          {agents.surface.kind === "team" ? (
            <TeamView
              teamSummary={agents.currentTeamSummary}
              teamTasks={agents.currentTeamTasks}
              activeTab={agents.surface.tab}
              selectedTaskId={agents.surface.selectedTaskId}
              busy={agents.busy}
              onTabChange={(tab) => agents.openTeam(agents.currentTeamId, tab, agents.surface.selectedTaskId)}
              onSelectTask={(teamId, taskId) => agents.selectTask(teamId, taskId)}
              onOpenChat={(target) => void agents.openAgentConversation(target)}
              onOpenManager={() => void agents.openAgentConversation({ manager: true })}
              onCreateMember={async ({ mode, teamId, name, workspace, repository, branch, position, responsibility, reportsToAgentId }) => {
                if (mode === "existing") {
                  await agents.runAction(
                    "addMember",
                    { teamId, workspace, name: name || undefined, position, responsibility, reportsToAgentId },
                    "Added folder to team",
                  );
                } else if (mode === "worktree") {
                  await agents.runAction(
                    "createWorktree",
                    { teamId, name, repository, branch, position, responsibility, reportsToAgentId },
                    `Created worktree member "${name}"`,
                  );
                } else {
                  await agents.runAction(
                    "createWorkspace",
                    { teamId, name, position, responsibility, reportsToAgentId },
                    `Created member "${name}"`,
                  );
                }
              }}
              onUpdateMember={({ teamId, agentId, position, responsibility }) =>
                agents.runAction("updateMember", { teamId, agentId, position, responsibility }, "Updated member role")
              }
              onRemoveMember={({ teamId, agentId }) =>
                agents.runAction("removeMember", { teamId, agentId }, "Removed member from team")
              }
              onSetLeader={({ teamId, agentId }) =>
                agents.runAction("setLeader", { teamId, agentId }, "Updated team leader")
              }
              onSetSupervisor={({ teamId, agentId, reportsToAgentId }) =>
                agents.runAction("setSupervisor", { teamId, agentId, reportsToAgentId }, "Updated reporting line")
              }
              onAssignTask={({ teamId, assigneeAgentId, brief, start }) =>
                agents.runAction("assignTask", { teamId, assigneeAgentId, brief, start }, "Assigned task")
              }
              onStartTask={(taskId) => agents.runAction("startTask", { taskId }, "Started task")}
              onCancelTask={(taskId) => agents.runAction("cancelTask", { taskId }, "Cancelled task")}
              onSetPriority={(taskId, priority) =>
                agents.runAction("setTaskPriority", { taskId, priority }, `Priority set to ${priority}`)
              }
              onReviewTask={(taskId, decision, feedback) =>
                agents.runAction(
                  "reviewTask",
                  { taskId, decision, ...(feedback ? { feedback } : {}) },
                  decision === "accept" ? "Accepted task delivery" : "Sent task back for rework",
                )
              }
              onPostNote={(taskId, text, answer) =>
                agents.runAction(
                  "postTaskNote",
                  { taskId, text, ...(answer ? { answer: true } : {}) },
                  answer ? "Answered blocker & resumed task" : "Added task note",
                )
              }
              onReadArtifact={(artifactId) => agents.requestAgent("readArtifactPreview", { artifactId })}
              onDeleteTeam={async ({ teamId, confirmName }) => {
                await agents.runAction("deleteTeam", { teamId, confirmName }, `Deleted team "${confirmName}"`);
                agents.openChatSurface();
              }}
            />
          ) : agents.surface.kind === "inbox" ? (
            <InboxView
              items={agents.inboxItems}
              busy={agents.busy}
              onResolveApproval={(approvalId, approve) =>
                agents.runAction(
                  "resolveApproval",
                  { approvalId, approve },
                  approve ? "Approved request" : "Declined request",
                )
              }
              onAnswerBlocker={(taskId, text) =>
                agents.runAction(
                  "postTaskNote",
                  { taskId, text, answer: true },
                  "Answered blocker & resumed task",
                )
              }
              onStartTask={(taskId) => agents.runAction("startTask", { taskId }, "Resumed task")}
              onReviewTask={(taskId, decision, feedback) =>
                agents.runAction(
                  "reviewTask",
                  { taskId, decision, ...(feedback ? { feedback } : {}) },
                  decision === "accept" ? "Accepted delivery" : "Sent back for rework",
                )
              }
              onResolveRun={(runId) =>
                agents.runAction("resolveRun", { runId, confirmStopped: true }, "Confirmed run stopped")
              }
              onDismissNotice={(noticeId) => agents.runAction("dismissNotice", { noticeId })}
              onOpenTask={(teamId, taskId) => agents.selectTask(teamId, taskId)}
              onOpenTeam={(teamId) => agents.openTeam(teamId, "organization")}
              onOpenChat={(target) => void agents.openAgentConversation(target)}
            />
          ) : agents.surface.kind === "background" ? (
            <BackgroundView
              snapshot={agents.snapshot}
              connection={agents.connection}
              service={agents.service}
              busy={agents.busy}
              onRefresh={() => agents.requestAgent("serviceInfo", {})}
              onRestartService={() => agents.runAction("restartService", {}, "Restarted management service")}
              onStopServices={(stopAgents) =>
                agents.runAction("stopServices", { stopAgents }, "Stopped background services")
              }
              onCancelRun={(runId) => agents.runAction("cancelRun", { runId }, "Cancelled run")}
              onResolveRun={(runId) =>
                agents.runAction("resolveRun", { runId, confirmStopped: true }, "Confirmed run stopped")
              }
              onReadLog={(target) => agents.requestAgent("serviceLog", { target })}
              onOpenTask={(teamId, taskId) => agents.selectTask(teamId, taskId)}
              onOpenSession={(id) => {
                agents.openChatSurface();
                void actions.handleSelectSession(id);
              }}
            />
          ) : (
            <>
              <Conversation
                ref={refs.conversation}
                messages={view.messages}
                draft={view.draft}
                active={view.active}
                collapsedCount={view.collapsedCount}
                turnChanges={view.turnChanges}
                turnFileList={view.turnFileList}
                canFork={canFork && !view.active}
                onAnswer={actions.answerQuestion}
                onExpire={actions.expireQuestion}
                onRetry={actions.retryTurn}
                onEdit={actions.editMessage}
                onFork={guardedFork}
                onQuote={(text) => {
                  const quoted = String(text || "").trim().split("\n").map((line) => `> ${line}`).join("\n");
                  if (!quoted) return;
                  ctx.setInput((prev) => (prev && prev.trim() ? `${prev.trimEnd()}\n\n${quoted}\n\n` : `${quoted}\n\n`));
                  refs.composer.current?.focus();
                }}
                onSuggestion={(value) => { ctx.setInput(value); refs.composer.current?.focus(); }}
                onOpenFile={openFile}
              />
              {/* Invariant: the composer is never disabled by connection state. */}
              <Composer
                key={sessionId || "new"}
                ref={refs.composer}
                value={ctx.input}
                onChange={ctx.setInput}
                onSubmit={actions.submit}
                active={view.active}
                loading={ctx.busySession}
                compacting={compacting}
                workspace={info.workspace_root || ctx.selectedWorkspace}
                awaitingAnswer={Boolean(ctx.conversation.question)}
                interruptArmed={ctx.interruptArmed}
                commands={ctx.commandList}
                queued={view.queued}
                lastPrompt={lastUserPrompt(view.messages)}
                model={ctx.currentModel || info.model || info.default_model || ""}
                models={info.models || []}
                providerId={ctx.currentProvider || info.provider || ""}
                providerNames={ctx.providerNames}
                effort={info.reasoning_effort || ""}
                stats={ctx.stats}
                onCancel={actions.cancelTurn}
                onUpload={actions.uploadAttachment}
                onPromote={actions.promoteQueued}
                onEditQueued={actions.retrieveQueued}
                onRemoveQueued={actions.removeQueued}
                onRefreshModels={() => actions.refreshModels(sessionId)}
                onModel={actions.setModel}
                onEffort={actions.setEffort}
                onOpenContext={() => layout.openInspector("context")}
                onError={(message) => ctx.toast.show(message, { tone: "error" })}
              />
            </>
          )}
        </main>
        {!layout.narrow && layout.inspectorVisible && (
          <ResizeHandle label="Resize inspector" width={layout.inspectorWidth} min={INSPECTOR_WIDTH.min} max={INSPECTOR_WIDTH.max} edge="start" onResize={layout.setInspectorWidth} />
        )}
        <Inspector
          visible={layout.inspectorVisible}
          tab={layout.inspectorTab}
          onTab={layout.setInspectorTab}
          onClose={layout.closeInspector}
          maximized={layout.inspectorMaximized}
          onToggleMaximize={!layout.narrow ? layout.toggleInspectorMaximized : undefined}
          info={info}
          stats={ctx.stats}
          contextSnapshot={ctx.contextSnapshot}
          contextInfo={ctx.contextInfo}
          plan={view.plan}
          backgroundWaitCount={view.backgroundWait?.count || 0}
          goal={ctx.goal}
          connected={connected}
          compacting={compacting || view.active}
          onCompact={() => void actions.compact()}
          onGoalAction={actions.handleGoalAction}
          request={request}
          workspace={info.workspace_root || ctx.selectedWorkspace}
          listFiles={actions.listFiles}
          readFile={actions.readFile}
          fileRequest={fileRequest}
          teamProps={{
            hasTeams,
            agentContext: agents.activeSessionContext,
            teamSummary: agents.currentTeamSummary,
            teamTasks: agents.currentTeamTasks,
            onOpenTeam: agents.openTeam,
            onSelectTask: agents.selectTask,
            onOpenChat: (target) => void agents.openAgentConversation(target),
            onOpenManager: () => void agents.openAgentConversation({ manager: true }),
          }}
          panelRef={layout.inspectorPanelRef}
          panelAttrs={panelAttrs({ narrow: layout.narrow, visible: layout.inspectorVisible })}
          style={
            layout.narrow
              ? undefined
              : layout.inspectorMaximized
                ? { width: "min(680px, 52vw)" }
                : { width: layout.inspectorWidth }
          }
        />
      </div>
      <SettingsDialog
        open={ctx.settingsOpen}
        onClose={() => ctx.setSettingsOpen(false)}
        theme={ctx.theme.preference}
        onTheme={ctx.theme.set}
        onLogout={() => { ctx.setSettingsOpen(false); void actions.logout(); }}
      />
      <UsageDialog open={usageOpen} onClose={() => setUsageOpen(false)} request={request} usageEnabled={tabs.usage} authEnabled={tabs.auth} />
      <CommandPalette open={ctx.paletteOpen} commands={ctx.commandList} onClose={actions.closePalette} onRun={(cmd) => {
        if (!isChatSurface) agents.openChatSurface();
        actions.runCommand(cmd);
      }} />
    </div>
  );
}
