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
import { methods } from "../methods.js";
import { INSPECTOR_WIDTH, SIDEBAR_WIDTH } from "./constants.js";
import { useAppController } from "./useAppController.js";
import { headerStatus, lastUserPrompt, panelAttrs, sessionTitle } from "./shellModel.js";

// The v2 shell (spec section 2): sidebar | header + conversation + composer |
// inspector. Below 768px the side panels become exclusive drawers over a scrim.
export function Shell() {
  const { ctx, actions, view, request, fileRequest, openFile } = useAppController();
  const { layout, info, connection, refs } = ctx;

  if (connection.phase === "login") {
    return <LoginGate onSubmit={actions.handleLogin} busy={ctx.authBusy} error={connection.message} initialToken={ctx.loginToken} />;
  }

  const sessionId = info.session_id || "";
  const available = info.methods || [];
  const canFork = available.includes(methods.sessionFork);
  const tabs = visibleTabs(info);
  const connected = connection.phase === "online" || connection.phase === "syncing";
  const drawerOpen = layout.narrow && Boolean(layout.drawer);

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
            onSelect: actions.selectWorkspace,
          }}
          canFork={canFork}
          canExport
          notificationPermission={ctx.notificationPermission}
          onNew={actions.createSession}
          onSelect={actions.handleSelectSession}
          onFork={(id) => void actions.forkSession(id, "")}
          onExport={(id) => void actions.exportSession(id)}
          onDelete={actions.deleteSession}
          onLoadMore={actions.loadMoreSessions}
          onEnableNotifications={actions.enableNotifications}
          onOpenSettings={() => ctx.setSettingsOpen(true)}
          panelRef={layout.sidebarPanelRef}
          panelAttrs={panelAttrs({ narrow: layout.narrow, visible: layout.sidebarVisible })}
          style={layout.narrow ? undefined : { width: layout.sidebarWidth }}
        />
        {!layout.narrow && layout.sidebarVisible && (
          <ResizeHandle label="Resize sidebar" width={layout.sidebarWidth} min={SIDEBAR_WIDTH.min} max={SIDEBAR_WIDTH.max} edge="end" onResize={layout.setSidebarWidth} />
        )}
        <main className="main-column" aria-busy={ctx.busySession}>
          <ChatHeader
            title={sessionTitle(ctx.sessions, sessionId)}
            status={headerStatus({ phase: connection.phase, active: view.active, compacting: ctx.compacting })}
            sidebarExpanded={layout.sidebarVisible}
            inspectorExpanded={layout.inspectorVisible}
            sidebarToggleRef={layout.sidebarToggleRef}
            inspectorToggleRef={layout.inspectorToggleRef}
            showTasks={tabs.tabs.includes("activity")}
            menuItems={headerMenuItems({
              hasSession: Boolean(sessionId),
              active: view.active,
              canFork,
              compacting: ctx.compacting,
              onPalette: () => ctx.setPaletteOpen(true),
              onFork: () => guardedFork(""),
              onExport: () => void actions.exportSession(sessionId),
              onCompact: () => void actions.compact(),
            })}
            onToggleSidebar={layout.toggleSidebar}
            onToggleInspector={layout.toggleInspector}
            onOpenTasks={() => layout.openInspector("activity")}
          />
          <Conversation
            ref={refs.conversation}
            messages={view.messages}
            draft={view.draft}
            active={view.active}
            collapsedCount={view.collapsedCount}
            turnChanges={view.turnChanges}
            canFork={canFork && !view.active}
            onAnswer={actions.answerQuestion}
            onExpire={actions.expireQuestion}
            onRetry={actions.retryTurn}
            onEdit={actions.editMessage}
            onFork={guardedFork}
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
            hasSession={Boolean(sessionId)}
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
        </main>
        {!layout.narrow && layout.inspectorVisible && (
          <ResizeHandle label="Resize inspector" width={layout.inspectorWidth} min={INSPECTOR_WIDTH.min} max={INSPECTOR_WIDTH.max} edge="start" onResize={layout.setInspectorWidth} />
        )}
        <Inspector
          tab={layout.inspectorTab}
          onTab={layout.setInspectorTab}
          onClose={layout.closeInspector}
          info={info}
          stats={ctx.stats}
          contextSnapshot={ctx.contextSnapshot}
          contextInfo={ctx.contextInfo}
          plan={view.plan}
          backgroundWaitCount={view.backgroundWait?.count || 0}
          goal={ctx.goal}
          connected={connected}
          compacting={ctx.compacting}
          onCompact={() => void actions.compact()}
          onGoalAction={actions.handleGoalAction}
          request={request}
          workspace={info.workspace_root || ctx.selectedWorkspace}
          listFiles={actions.listFiles}
          readFile={actions.readFile}
          fileRequest={fileRequest}
          panelRef={layout.inspectorPanelRef}
          panelAttrs={panelAttrs({ narrow: layout.narrow, visible: layout.inspectorVisible })}
          style={layout.narrow ? undefined : { width: layout.inspectorWidth }}
        />
      </div>
      <SettingsDialog
        open={ctx.settingsOpen}
        onClose={() => ctx.setSettingsOpen(false)}
        theme={ctx.theme.preference}
        onTheme={ctx.theme.set}
        onLogout={() => { ctx.setSettingsOpen(false); void actions.logout(); }}
      />
      <CommandPalette open={ctx.paletteOpen} commands={ctx.commandList} onClose={actions.closePalette} onRun={actions.runCommand} />
    </div>
  );
}
