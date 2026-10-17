import {
  activeBackgroundCount,
  buildTeamSummary,
  DEFAULT_SIDEBAR_SESSIONS_LIMIT,
  inboxBadgeCount,
  mergeManagerSessions,
  mergeTeamSessions,
  normalizeAgentsSnapshot,
  renderArchiveSurfaceHtml,
  renderBackgroundSurfaceHtml,
  renderHeaderAgentBreadcrumbHtml,
  renderInboxSurfaceHtml,
  renderManagerSurfaceHtml,
  renderSidebarAgentsHtml,
  renderTeamSurfaceHtml,
  resolveSessionAgentContext,
  type SessionAgentContext,
} from "../agents-model.ts"
import { createConversation } from "../timeline-model.ts"
import {
  agentsSurface,
  composerRegion,
  conversationHead,
  prompt,
  sessionAgentContext,
  sidebarAgents,
  sidebarModeAgents,
  sidebarModeAgentsBadges,
  sidebarModeSwitcher,
  sidebarModeWorkspaces,
  sidebarWorkspacesPane,
  streamWrap,
} from "./dom.ts"
import { loadDirectory } from "./files-panel.ts"
import { asRecord, asRecordText } from "./html.ts"
import { showToast } from "./overlays.ts"
import { loadReplay, resetConversationPresentation, runAction } from "./runtime.ts"
import { exportSessionReplay, forkSession, loadSessions, restoreProjectDraft } from "./sessions.ts"
import { render, scheduleRender } from "./shell.ts"
import { state, vars } from "./state.ts"

let lastSidebarKey = ""
let lastSurfaceKey = ""
let lastRefreshedSeq = -1
let refreshInFlight = false

export function currentSessionAgentContext(): SessionAgentContext {
  if (state.agentChatContext && state.agentChatContext.kind !== "independent") {
    return state.agentChatContext
  }
  return resolveSessionAgentContext(
    state.agentsSnapshot,
    state.viewedSessionId,
    state.viewedProjectPath || state.chatProjectPath,
  )
}

export async function refreshAgentSessionsAndArchive() {
  if (!window.api.agents || refreshInFlight) return
  refreshInFlight = true
  try {
    const teams = state.agentsSnapshot.teams || []
    const [managerRes, archiveRes, ...teamResults] = await Promise.all([
      window.api.agents.request("listSessions", { manager: true }).catch(() => null),
      window.api.agents.request("listArchive", {}).catch(() => null),
      ...teams.map((team) =>
        window.api.agents
          .request("listSessions", { teamId: team.id })
          .then((res) => ({ teamId: String(team.id), res }))
          .catch(() => ({ teamId: String(team.id), res: null })),
      ),
    ])

    const mgrRec = asRecord(managerRes)
    if (Array.isArray(mgrRec.sessions)) {
      state.managerSessions = mgrRec.sessions as Array<Record<string, any>>
    }
    const archRec = asRecord(archiveRes)
    if (Array.isArray(archRec.archivedTeams)) {
      state.archivedTeams = archRec.archivedTeams as Array<Record<string, any>>
    }
    const nextTeamSessions: Record<string, Array<Record<string, any>>> = { ...state.teamSessionsByTeam }
    for (const item of teamResults) {
      const rec = asRecord(item.res)
      if (Array.isArray(rec.sessions)) {
        nextTeamSessions[item.teamId] = rec.sessions as Array<Record<string, any>>
      }
    }
    state.teamSessionsByTeam = nextTeamSessions
    scheduleRender()
  } finally {
    refreshInFlight = false
  }
}

export function renderAgentsUI() {
  const snapshot = state.agentsSnapshot
  if (snapshot.seq !== lastRefreshedSeq && window.api.agents) {
    lastRefreshedSeq = snapshot.seq
    void refreshAgentSessionsAndArchive()
  }

  const chatContext = currentSessionAgentContext()
  const isAgentSurface = state.agentSurface.kind !== "chat"

  // Sidebar two-mode switcher (Workspaces | Agents & Teams)
  const isAgentsMode = state.sidebarMode === "agents"
  sidebarModeWorkspaces.classList.toggle("is-active", !isAgentsMode)
  sidebarModeWorkspaces.setAttribute("aria-selected", String(!isAgentsMode))
  sidebarModeAgents.classList.toggle("is-active", isAgentsMode)
  sidebarModeAgents.setAttribute("aria-selected", String(isAgentsMode))
  sidebarWorkspacesPane.hidden = isAgentsMode
  sidebarAgents.hidden = !isAgentsMode

  const inboxCount = inboxBadgeCount(snapshot)
  const bgCount = activeBackgroundCount(snapshot)
  sidebarModeAgentsBadges.innerHTML = [
    inboxCount > 0 ? `<span class="sidebar-nav-badge attention" title="${inboxCount} pending in Inbox">! ${inboxCount}</span>` : "",
    bgCount > 0 ? `<span class="sidebar-nav-badge working" title="${bgCount} active runs">● ${bgCount}</span>` : "",
  ].join("")

  // Toggle center-stage dedicated panel vs conversation header + stream + composer
  agentsSurface.hidden = !isAgentSurface
  if (conversationHead) conversationHead.hidden = isAgentSurface
  streamWrap.hidden = isAgentSurface
  if (composerRegion) composerRegion.hidden = isAgentSurface

  // Header agent context breadcrumb + Sessions switcher
  let activeAgentSessions = [] as ReturnType<typeof mergeManagerSessions>
  if (chatContext.kind === "manager") {
    activeAgentSessions = mergeManagerSessions(snapshot, state.managerSessions)
  } else if (chatContext.kind === "member") {
    const byAgent = mergeTeamSessions(snapshot, chatContext.teamId, state.teamSessionsByTeam[chatContext.teamId] || [])
    activeAgentSessions = byAgent.get(chatContext.agentId) || []
  }

  const breadcrumbHtml = renderHeaderAgentBreadcrumbHtml(chatContext, {
    sessions: activeAgentSessions,
    viewedSessionId: state.viewedSessionId,
    menuOpen: state.headerSessionsMenuOpen,
  })
  sessionAgentContext.innerHTML = breadcrumbHtml
  sessionAgentContext.hidden = !breadcrumbHtml || isAgentSurface

  // Sidebar navigation
  const activeSidebarInput = sidebarAgents.querySelector<HTMLInputElement>("input:focus")
  const sidebarKey = JSON.stringify({
    seq: snapshot.seq,
    mode: state.sidebarMode,
    surface: state.agentSurface.kind === "team" ? `team:${state.agentSurface.teamId}:${state.agentSurface.tab}` : state.agentSurface.kind,
    chatKind: chatContext.kind,
    chatAgent: chatContext.kind === "member" ? chatContext.agentId : "",
    viewedSessionId: state.viewedSessionId,
    collapsed: [...state.collapsedTeams],
    expandedMembers: [...state.expandedSidebarMembers],
    managerExpanded: state.managerExpanded,
    itemMenuKey: state.agentItemMenuKey,
    sessionMenuId: state.sessionMenuId,
    sessionDeleteConfirmId: state.sessionDeleteConfirmId,
    sessionDeleteBusyId: state.sessionDeleteBusyId,
    sessionLimits: state.agentSessionLimits,
    teamSessionCounts: Object.entries(state.teamSessionsByTeam).map(([k, v]) => `${k}:${v.length}`),
    mgrSessionCount: state.managerSessions.length,
    archiveCount: state.archivedTeams.length,
    newTeamOpen: state.newTeamOpen,
    busy: state.agentsBusy,
  })
  if (!activeSidebarInput && sidebarKey !== lastSidebarKey) {
    lastSidebarKey = sidebarKey
    sidebarAgents.innerHTML = renderSidebarAgentsHtml({
      snapshot,
      surface: state.agentSurface,
      chatContext,
      collapsedTeams: state.collapsedTeams,
      expandedSidebarMembers: state.expandedSidebarMembers,
      managerExpanded: state.managerExpanded,
      teamSessionsByTeam: state.teamSessionsByTeam,
      managerSessions: state.managerSessions,
      archivedTeams: state.archivedTeams,
      viewedSessionId: state.viewedSessionId,
      itemMenuKey: state.agentItemMenuKey,
      sessionMenuId: state.sessionMenuId,
      sessionDeleteConfirmId: state.sessionDeleteConfirmId,
      sessionDeleteBusyId: state.sessionDeleteBusyId,
      sessionLimits: state.agentSessionLimits,
      newTeamOpen: state.newTeamOpen,
      busy: state.agentsBusy,
    })
  }

  // Center-stage multi-agent surface
  if (isAgentSurface) {
    const activeSurfaceInput = agentsSurface.querySelector<HTMLElement>("input:focus, textarea:focus, select:focus")
    const surfaceKey = JSON.stringify({
      seq: snapshot.seq,
      surface: state.agentSurface,
      inboxTask: state.inboxSelectedTaskId,
      viewedSessionId: state.viewedSessionId,
      expandedOrg: [...state.expandedOrgMembers],
      sessionLimits: state.agentSessionLimits,
      teamSessionCounts: Object.entries(state.teamSessionsByTeam).map(([k, v]) => `${k}:${v.length}`),
      mgrSessionCount: state.managerSessions.length,
      archiveCount: state.archivedTeams.length,
      busy: state.agentsBusy,
      artifactPath: state.artifactPreview?.path || "",
      logTitle: state.serviceLogView?.title || "",
      hasService: Boolean(state.agentsService),
    })
    if (!activeSurfaceInput && surfaceKey !== lastSurfaceKey) {
      lastSurfaceKey = surfaceKey
      if (state.agentSurface.kind === "team") {
        agentsSurface.innerHTML = renderTeamSurfaceHtml({
          snapshot,
          surface: state.agentSurface,
          teamSessions: state.teamSessionsByTeam[state.agentSurface.teamId] || [],
          expandedOrgMembers: state.expandedOrgMembers,
          viewedSessionId: state.viewedSessionId,
          sessionLimits: state.agentSessionLimits,
          busy: state.agentsBusy,
          artifactPreview: state.artifactPreview,
        })
      } else if (state.agentSurface.kind === "inbox") {
        agentsSurface.innerHTML = renderInboxSurfaceHtml({
          snapshot,
          selectedTaskId: state.inboxSelectedTaskId,
          busy: state.agentsBusy,
          artifactPreview: state.artifactPreview,
        })
      } else if (state.agentSurface.kind === "manager") {
        agentsSurface.innerHTML = renderManagerSurfaceHtml({
          snapshot,
          managerSessions: state.managerSessions,
          viewedSessionId: state.viewedSessionId,
          busy: state.agentsBusy,
        })
      } else if (state.agentSurface.kind === "background") {
        agentsSurface.innerHTML = renderBackgroundSurfaceHtml({
          snapshot,
          serviceInfo: state.agentsService,
          logView: state.serviceLogView,
          busy: state.agentsBusy,
        })
      } else if (state.agentSurface.kind === "archive") {
        agentsSurface.innerHTML = renderArchiveSurfaceHtml({
          snapshot,
          archivedTeams: state.archivedTeams,
        })
      }
    }
  } else {
    lastSurfaceKey = ""
  }
}

export function openTeamSurface(teamId: string, tab: "organization" | "tasks" = "organization", selectedTaskId = "") {
  state.sidebarMode = "agents"
  state.artifactPreview = null
  state.headerSessionsMenuOpen = false
  state.agentItemMenuKey = ""
  state.sessionMenuId = ""
  state.collapsedTeams.delete(teamId)
  state.agentSurface = {
    kind: "team",
    teamId,
    tab,
    assigneeFilter: "",
    selectedTaskId,
    addMemberOpen: false,
    memberMode: "workspace",
    assignOpen: false,
    assignAgentId: "",
    deleteConfirmOpen: false,
  }
  render()
}

export async function openManagedAgentChat(options: {
  manager?: boolean
  teamId?: string
  agentId?: string
  existingRuntimeSessionId?: string
  resumeLatest?: boolean
}) {
  state.agentsBusy = true
  state.sidebarMode = "agents"
  state.headerSessionsMenuOpen = false
  state.agentItemMenuKey = ""
  state.sessionMenuId = ""
  state.notice = ""
  render()
  try {
    const opened = asRecord(
      await window.api.agents.openSession({
        manager: Boolean(options.manager),
        teamId: options.teamId,
        agentId: options.agentId,
        runtimeSessionId: options.existingRuntimeSessionId || undefined,
        resumeLatest: options.resumeLatest !== undefined ? options.resumeLatest : !options.existingRuntimeSessionId,
        origin: "direct",
      }),
    )
    if (opened.snapshot) {
      state.agentsSnapshot = normalizeAgentsSnapshot(opened.snapshot)
    }
    const mgmtSession = asRecord(opened.session)
    const managementSessionId = asRecordText(opened.managementSessionId) || asRecordText(mgmtSession.id)
    const workspaceRoot = asRecordText(opened.workspaceRoot) || state.chatProjectPath
    let runtimeSessionId =
      asRecordText(opened.runtimeSessionId) ||
      asRecordText(mgmtSession.runtimeSessionId) ||
      asRecordText(mgmtSession.session_id) ||
      String(options.existingRuntimeSessionId || "")

    // If no existing runtime session was resolved (either starting a brand-new conversation
    // or opening an agent that has no conversations yet), create and bind a fresh runtime session immediately.
    if (!runtimeSessionId && workspaceRoot) {
      const created = asRecord(
        await window.api.agents.createSession({
          managementSessionId,
          manager: Boolean(options.manager),
          teamId: options.teamId,
          agentId: options.agentId,
          workspace_root: workspaceRoot,
        }),
      )
      if (created.snapshot) {
        state.agentsSnapshot = normalizeAgentsSnapshot(created.snapshot)
      }
      const rt = asRecord(created.runtimeSession || created)
      runtimeSessionId = asRecordText(rt.session_id) || asRecordText(created.runtimeSessionId)
    }

    if (options.manager) {
      state.managerExpanded = true
      state.agentChatContext = {
        kind: "manager",
        managementSessionId,
        workspaceRoot,
        agentName: "Manager",
        roleLabel: "Organization Coordinator",
      }
    } else if (options.teamId && options.agentId) {
      const team = state.agentsSnapshot.teams.find((t) => t.id === options.teamId)
      const agent = state.agentsSnapshot.agents.find((a) => a.id === options.agentId)
      const membership = state.agentsSnapshot.memberships.find(
        (m) => m.teamId === options.teamId && m.agentId === options.agentId,
      )
      state.collapsedTeams.delete(options.teamId)
      state.expandedSidebarMembers.add(`${options.teamId}:${options.agentId}`)
      state.agentChatContext = {
        kind: "member",
        managementSessionId,
        workspaceRoot,
        teamId: options.teamId,
        teamName: String(team?.name || options.teamId),
        agentId: options.agentId,
        agentName: String(agent?.name || options.agentId),
        roleLabel: String(
          membership?.position || (team?.leaderAgentId === options.agentId ? "Team Leader" : "Specialist"),
        ),
        isLeader: team?.leaderAgentId === options.agentId,
        status: String(membership?.status || "Idle"),
      }
    }

    const folderChanged = state.viewedProjectPath !== workspaceRoot
    state.agentSurface = { kind: "chat" }
    state.chatProjectPath = workspaceRoot
    state.viewedProjectPath = workspaceRoot
    if (folderChanged) {
      state.fileListings = {}
      state.expandedDirectories = new Set()
      state.filePreview = undefined
      if (state.inspectorOpen && state.inspectorTab === "files") {
        void loadDirectory("").catch(() => {})
      }
    }

    if (runtimeSessionId) {
      state.viewedSessionId = runtimeSessionId
      state.conversation = state.conversationCache[runtimeSessionId] || createConversation()
      resetConversationPresentation()
      restoreProjectDraft()
      render()
      await loadSessions().catch(() => {})
      await loadReplay(runtimeSessionId)
      render()
    } else {
      state.viewedSessionId = ""
      state.conversation = createConversation()
      resetConversationPresentation()
      restoreProjectDraft()
      render()
    }
    void refreshAgentSessionsAndArchive()
    prompt.focus()
  } finally {
    state.agentsBusy = false
    render()
  }
}

async function runManagementOp(op: Record<string, unknown>, toastMessage = "") {
  state.agentsBusy = true
  render()
  try {
    const { op: method, ...params } = op
    const res = asRecord(await window.api.agents.request(String(method || "getState"), params))
    if (res.snapshot) {
      state.agentsSnapshot = normalizeAgentsSnapshot(res.snapshot)
    }
    if (toastMessage) showToast(toastMessage, "success")
    void refreshAgentSessionsAndArchive()
    return res
  } finally {
    state.agentsBusy = false
    render()
  }
}

function resetAgentSessionDeleteConfirm() {
  state.sessionDeleteConfirmId = ""
  if (vars.deleteConfirmTimer) {
    clearTimeout(vars.deleteConfirmTimer)
    vars.deleteConfirmTimer = undefined
  }
}

export function bindAgentsEvents(): () => void {
  const handleModeClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    const modeBtn = target.closest<HTMLElement>("[data-sidebar-mode]")
    if (!modeBtn) return
    const nextMode = modeBtn.dataset.sidebarMode === "agents" ? "agents" : "workspaces"
    state.sidebarMode = nextMode
    state.agentItemMenuKey = ""
    state.sessionMenuId = ""
    if (nextMode === "workspaces" && state.agentSurface.kind !== "chat") {
      state.agentSurface = { kind: "chat" }
    }
    render()
  }

  const handleContainerClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement

    if (target.closest("[data-agent-top-new-chat]")) {
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      const chatCtx = currentSessionAgentContext()
      if (chatCtx.kind === "member") {
        runAction(() =>
          openManagedAgentChat({
            teamId: chatCtx.teamId,
            agentId: chatCtx.agentId,
            resumeLatest: false,
          }),
        )
        return
      }
      if (state.agentSurface.kind === "team") {
        const summary = buildTeamSummary(
          state.agentsSnapshot,
          state.agentSurface.teamId,
          state.teamSessionsByTeam[state.agentSurface.teamId] || [],
        )
        if (summary?.leader) {
          runAction(() =>
            openManagedAgentChat({
              teamId: summary.team.id,
              agentId: summary.leader!.agentId,
              resumeLatest: false,
            }),
          )
          return
        }
      }
      runAction(() => openManagedAgentChat({ manager: true, resumeLatest: false }))
      return
    }

    if (target.closest("[data-header-toggle-sessions]")) {
      state.headerSessionsMenuOpen = !state.headerSessionsMenuOpen
      render()
      return
    }

    const itemMenuBtn = target.closest<HTMLElement>("[data-agent-item-menu]")
    if (itemMenuBtn?.dataset.agentItemMenu) {
      const key = itemMenuBtn.dataset.agentItemMenu
      state.agentItemMenuKey = state.agentItemMenuKey === key ? "" : key
      state.sessionMenuId = ""
      resetAgentSessionDeleteConfirm()
      render()
      return
    }

    const sessMenuBtn = target.closest<HTMLElement>("[data-agent-session-menu]")
    if (sessMenuBtn?.dataset.agentSessionMenu) {
      const sid = sessMenuBtn.dataset.agentSessionMenu
      state.agentItemMenuKey = ""
      resetAgentSessionDeleteConfirm()
      state.sessionMenuId = state.sessionMenuId === sid ? "" : sid
      render()
      return
    }

    const forkBtn = target.closest<HTMLElement>("[data-agent-session-fork]")
    if (forkBtn?.dataset.agentSessionFork) {
      const forkId = forkBtn.dataset.agentSessionFork
      state.sessionMenuId = ""
      resetAgentSessionDeleteConfirm()
      render()
      runAction(() => forkSession(forkId), forkId)
      return
    }

    const exportBtn = target.closest<HTMLElement>("[data-agent-session-export]")
    if (exportBtn?.dataset.agentSessionExport) {
      const exportId = exportBtn.dataset.agentSessionExport
      const title = exportBtn.dataset.sessionTitle || "Rind conversation"
      state.sessionMenuId = ""
      resetAgentSessionDeleteConfirm()
      render()
      runAction(() => exportSessionReplay(exportId, title))
      return
    }

    const moreSessionsBtn = target.closest<HTMLElement>("[data-agent-more-sessions]")
    if (moreSessionsBtn?.dataset.agentMoreSessions) {
      const key = moreSessionsBtn.dataset.agentMoreSessions
      const current = state.agentSessionLimits[key] || DEFAULT_SIDEBAR_SESSIONS_LIMIT
      state.agentSessionLimits = {
        ...state.agentSessionLimits,
        [key]: current + DEFAULT_SIDEBAR_SESSIONS_LIMIT,
      }
      render()
      return
    }

    const surfaceBtn = target.closest<HTMLElement>("[data-sidebar-surface]")
    if (surfaceBtn) {
      const next = surfaceBtn.dataset.sidebarSurface
      state.artifactPreview = null
      state.headerSessionsMenuOpen = false
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      if (next === "inbox") {
        state.sidebarMode = "agents"
        state.agentSurface = { kind: "inbox" }
      } else if (next === "manager") {
        state.sidebarMode = "agents"
        state.managerExpanded = true
        state.agentSurface = { kind: "manager" }
      } else if (next === "background") {
        state.sidebarMode = "agents"
        state.agentSurface = { kind: "background" }
      } else if (next === "archive") {
        state.sidebarMode = "agents"
        state.agentSurface = { kind: "archive" }
      } else {
        state.agentSurface = { kind: "chat" }
      }
      render()
      return
    }

    if (target.closest("[data-sidebar-toggle-manager]")) {
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      if (!state.managerExpanded) {
        state.managerExpanded = true
        state.agentSurface = { kind: "manager" }
      } else if (state.agentSurface.kind !== "manager") {
        state.agentSurface = { kind: "manager" }
      } else {
        state.managerExpanded = false
      }
      render()
      return
    }

    if (target.closest("[data-sidebar-open-manager]")) {
      state.agentItemMenuKey = ""
      runAction(() => openManagedAgentChat({ manager: true, resumeLatest: true }))
      return
    }

    if (target.closest("[data-sidebar-new-manager-session]")) {
      state.agentItemMenuKey = ""
      runAction(() => openManagedAgentChat({ manager: true, resumeLatest: false }))
      return
    }

    const openMgrSessBtn = target.closest<HTMLElement>("[data-sidebar-open-manager-session]")
    if (openMgrSessBtn?.dataset.sidebarOpenManagerSession) {
      const sid = openMgrSessBtn.dataset.sidebarOpenManagerSession
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      runAction(() => openManagedAgentChat({ manager: true, existingRuntimeSessionId: sid, resumeLatest: false }))
      return
    }

    const toggleNewTeamBtn = target.closest<HTMLElement>("[data-sidebar-toggle-new-team]")
    if (toggleNewTeamBtn) {
      state.newTeamOpen = !state.newTeamOpen
      state.agentItemMenuKey = ""
      render()
      return
    }

    const toggleTeamCollapseBtn = target.closest<HTMLElement>("[data-sidebar-toggle-team]")
    if (toggleTeamCollapseBtn?.dataset.sidebarToggleTeam) {
      const teamId = toggleTeamCollapseBtn.dataset.sidebarToggleTeam
      const isCollapsed = state.collapsedTeams.has(teamId)
      const isShowingTeam = state.agentSurface.kind === "team" && state.agentSurface.teamId === teamId
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      if (isCollapsed) {
        state.collapsedTeams.delete(teamId)
        openTeamSurface(teamId, "organization")
      } else if (!isShowingTeam) {
        openTeamSurface(teamId, "organization")
      } else {
        state.collapsedTeams.add(teamId)
        render()
      }
      return
    }

    const teamMenuActionBtn = target.closest<HTMLElement>("[data-sidebar-team-action]")
    if (teamMenuActionBtn?.dataset.sidebarTeamAction && teamMenuActionBtn.dataset.teamId) {
      const action = teamMenuActionBtn.dataset.sidebarTeamAction
      const teamId = teamMenuActionBtn.dataset.teamId
      state.agentItemMenuKey = ""
      state.collapsedTeams.delete(teamId)
      state.agentSurface = {
        kind: "team",
        teamId,
        tab: "organization",
        assigneeFilter: "",
        selectedTaskId: "",
        addMemberOpen: action === "add-member",
        memberMode: "workspace",
        assignOpen: action === "assign",
        assignAgentId: "",
        deleteConfirmOpen: action === "delete",
      }
      render()
      return
    }

    const memberAssignBtn = target.closest<HTMLElement>("[data-sidebar-member-assign]")
    if (memberAssignBtn?.dataset.sidebarMemberAssign && memberAssignBtn.dataset.teamId) {
      const agentId = memberAssignBtn.dataset.sidebarMemberAssign
      const teamId = memberAssignBtn.dataset.teamId
      state.agentItemMenuKey = ""
      state.collapsedTeams.delete(teamId)
      state.agentSurface = {
        kind: "team",
        teamId,
        tab: "organization",
        assigneeFilter: "",
        selectedTaskId: "",
        addMemberOpen: false,
        memberMode: "workspace",
        assignOpen: true,
        assignAgentId: agentId,
        deleteConfirmOpen: false,
      }
      render()
      return
    }

    const toggleMemberBtn = target.closest<HTMLElement>("[data-sidebar-toggle-member]")
    if (toggleMemberBtn?.dataset.sidebarToggleMember) {
      const memberKey = toggleMemberBtn.dataset.sidebarToggleMember
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      if (state.expandedSidebarMembers.has(memberKey)) state.expandedSidebarMembers.delete(memberKey)
      else state.expandedSidebarMembers.add(memberKey)
      render()
      return
    }

    const toggleOrgMemberSessionsBtn = target.closest<HTMLElement>("[data-org-toggle-member-sessions]")
    if (toggleOrgMemberSessionsBtn?.dataset.orgToggleMemberSessions) {
      const agentId = toggleOrgMemberSessionsBtn.dataset.orgToggleMemberSessions
      if (state.expandedOrgMembers.has(agentId)) state.expandedOrgMembers.delete(agentId)
      else state.expandedOrgMembers.add(agentId)
      render()
      return
    }

    const openTeamBtn = target.closest<HTMLElement>("[data-sidebar-open-team]")
    if (openTeamBtn?.dataset.sidebarOpenTeam) {
      const teamId = openTeamBtn.dataset.sidebarOpenTeam
      const tab = openTeamBtn.dataset.sidebarTeamTab === "tasks" ? "tasks" : "organization"
      openTeamSurface(teamId, tab)
      return
    }

    const newSessionBtn = target.closest<HTMLElement>("[data-agent-new-session]")
    if (newSessionBtn?.dataset.agentNewSession) {
      const agentId = newSessionBtn.dataset.agentNewSession
      const teamId = newSessionBtn.dataset.agentTeam || ""
      state.agentItemMenuKey = ""
      runAction(() =>
        openManagedAgentChat({
          teamId,
          agentId,
          resumeLatest: false,
        }),
      )
      return
    }

    const deleteSessionBtn = target.closest<HTMLElement>("[data-agent-delete-session]")
    if (deleteSessionBtn?.dataset.agentDeleteSession) {
      const runtimeSessionId = deleteSessionBtn.dataset.agentDeleteSession
      const insideSessionMenu = Boolean(deleteSessionBtn.closest(".session-menu"))
      if (insideSessionMenu && state.sessionDeleteConfirmId !== runtimeSessionId) {
        resetAgentSessionDeleteConfirm()
        state.sessionDeleteConfirmId = runtimeSessionId
        render()
        vars.deleteConfirmTimer = setTimeout(() => {
          if (state.sessionDeleteConfirmId === runtimeSessionId) {
            state.sessionDeleteConfirmId = ""
            render()
          }
        }, 4000)
        return
      }
      resetAgentSessionDeleteConfirm()
      state.sessionMenuId = ""
      state.sessionDeleteBusyId = runtimeSessionId
      render()
      runAction(async () => {
        try {
          await runManagementOp({ op: "deleteSession", runtimeSessionId }, "Session deleted.")
          await window.api.sessions.remove(runtimeSessionId).catch(() => {})
          if (state.viewedSessionId === runtimeSessionId) {
            state.viewedSessionId = ""
            state.conversation = createConversation()
            resetConversationPresentation()
          }
        } finally {
          state.sessionDeleteBusyId = ""
          render()
        }
      })
      return
    }

    const chatBtn = target.closest<HTMLElement>("[data-agent-chat]")
    if (chatBtn?.dataset.agentChat) {
      const agentId = chatBtn.dataset.agentChat
      const teamId = chatBtn.dataset.agentTeam || ""
      const existingRuntimeSessionId = chatBtn.dataset.agentSession || ""
      state.agentItemMenuKey = ""
      state.sessionMenuId = ""
      runAction(() =>
        openManagedAgentChat({
          teamId,
          agentId,
          existingRuntimeSessionId,
          resumeLatest: !existingRuntimeSessionId,
        }),
      )
      return
    }

    const selectTaskBtn = target.closest<HTMLElement>("[data-agent-select-task]")
    if (selectTaskBtn?.dataset.agentSelectTask) {
      const taskId = selectTaskBtn.dataset.agentSelectTask
      const teamId =
        selectTaskBtn.dataset.agentTeam ||
        (state.agentSurface.kind === "team" ? state.agentSurface.teamId : "")
      state.artifactPreview = null
      if (state.agentSurface.kind === "team" && state.agentSurface.teamId === teamId) {
        state.agentSurface = { ...state.agentSurface, selectedTaskId: taskId }
        render()
      } else if (teamId) {
        openTeamSurface(teamId, "tasks", taskId)
      }
      return
    }

    if (target.closest("[data-task-drawer-close]")) {
      state.artifactPreview = null
      if (state.agentSurface.kind === "team") {
        state.agentSurface = { ...state.agentSurface, selectedTaskId: "" }
      } else if (state.agentSurface.kind === "inbox") {
        state.inboxSelectedTaskId = ""
      }
      render()
      return
    }

    const switchTabBtn = target.closest<HTMLElement>("[data-team-switch-tab]")
    if (switchTabBtn && state.agentSurface.kind === "team") {
      const tab = switchTabBtn.dataset.teamSwitchTab === "tasks" ? "tasks" : "organization"
      state.agentSurface = { ...state.agentSurface, tab }
      render()
      return
    }

    const filterBtn = target.closest<HTMLElement>("[data-team-filter-assignee]")
    if (filterBtn && state.agentSurface.kind === "team") {
      state.agentSurface = {
        ...state.agentSurface,
        assigneeFilter: filterBtn.dataset.teamFilterAssignee || "",
      }
      render()
      return
    }

    const toggleAddMemberBtn = target.closest<HTMLElement>("[data-team-toggle-add-member]")
    if (toggleAddMemberBtn && state.agentSurface.kind === "team") {
      const open = toggleAddMemberBtn.dataset.teamToggleAddMember === "1"
      state.agentSurface = {
        ...state.agentSurface,
        addMemberOpen: open,
        assignOpen: false,
        deleteConfirmOpen: false,
      }
      render()
      return
    }

    const memberModeBtn = target.closest<HTMLElement>("[data-member-mode]")
    if (memberModeBtn && state.agentSurface.kind === "team") {
      const mode = memberModeBtn.dataset.memberMode
      if (mode === "workspace" || mode === "existing" || mode === "worktree") {
        state.agentSurface = { ...state.agentSurface, memberMode: mode }
        render()
      }
      return
    }

    const toggleAssignBtn = target.closest<HTMLElement>("[data-team-toggle-assign]")
    if (toggleAssignBtn && state.agentSurface.kind === "team") {
      const open = toggleAssignBtn.dataset.teamToggleAssign === "1"
      state.agentSurface = {
        ...state.agentSurface,
        assignOpen: open,
        addMemberOpen: false,
        deleteConfirmOpen: false,
      }
      render()
      return
    }

    const quickAssignBtn = target.closest<HTMLElement>("[data-agent-quick-assign]")
    if (quickAssignBtn && state.agentSurface.kind === "team") {
      state.agentSurface = {
        ...state.agentSurface,
        assignOpen: true,
        assignAgentId: quickAssignBtn.dataset.agentQuickAssign || "",
        addMemberOpen: false,
        deleteConfirmOpen: false,
      }
      render()
      return
    }

    const toggleDeleteBtn = target.closest<HTMLElement>("[data-team-toggle-delete]")
    if (toggleDeleteBtn && state.agentSurface.kind === "team") {
      const open = toggleDeleteBtn.dataset.teamToggleDelete === "1"
      state.agentSurface = {
        ...state.agentSurface,
        deleteConfirmOpen: open,
        addMemberOpen: false,
        assignOpen: false,
      }
      render()
      return
    }

    const makeLeaderBtn = target.closest<HTMLElement>("[data-agent-make-leader]")
    if (makeLeaderBtn?.dataset.agentMakeLeader && makeLeaderBtn.dataset.agentTeam) {
      const agentId = makeLeaderBtn.dataset.agentMakeLeader
      const teamId = makeLeaderBtn.dataset.agentTeam
      runAction(() => runManagementOp({ op: "setLeader", teamId, agentId }, "Team leader updated."))
      return
    }

    const removeMemberBtn = target.closest<HTMLElement>("[data-agent-remove]")
    if (removeMemberBtn?.dataset.agentRemove && removeMemberBtn.dataset.agentTeam) {
      const agentId = removeMemberBtn.dataset.agentRemove
      const teamId = removeMemberBtn.dataset.agentTeam
      runAction(() => runManagementOp({ op: "removeMember", teamId, agentId }, "Member removed from team."))
      return
    }

    const startTaskBtn = target.closest<HTMLElement>("[data-task-start]")
    if (startTaskBtn?.dataset.taskStart) {
      const taskId = startTaskBtn.dataset.taskStart
      runAction(() => runManagementOp({ op: "startTask", taskId }, "Task started."))
      return
    }

    const cancelTaskBtn = target.closest<HTMLElement>("[data-task-cancel]")
    if (cancelTaskBtn?.dataset.taskCancel) {
      const taskId = cancelTaskBtn.dataset.taskCancel
      runAction(() => runManagementOp({ op: "cancelTask", taskId }, "Task cancelled."))
      return
    }

    const reviewTaskBtn = target.closest<HTMLElement>("[data-task-review]")
    if (reviewTaskBtn?.dataset.taskReview) {
      const taskId = reviewTaskBtn.dataset.taskReview
      const decision = reviewTaskBtn.dataset.reviewDecision === "rework" ? "rework" : "accept"
      const commentEl = document.getElementById("agent-task-review-comment") as HTMLTextAreaElement | null
      const feedback = commentEl?.value.trim() || ""
      runAction(() =>
        runManagementOp(
          { op: "reviewTask", taskId, decision, feedback: feedback || undefined },
          decision === "accept" ? "Delivery accepted." : "Sent back for rework.",
        ),
      )
      return
    }

    const readArtifactBtn = target.closest<HTMLElement>("[data-task-read-artifact]")
    if (readArtifactBtn?.dataset.taskReadArtifact) {
      const artifactId = readArtifactBtn.dataset.taskReadArtifact
      const path = readArtifactBtn.dataset.artifactPath || artifactId
      if (state.artifactPreview?.artifactId === artifactId) {
        state.artifactPreview = null
        render()
        return
      }
      runAction(async () => {
        const res = await runManagementOp({ op: "readArtifact", artifactId })
        const art = asRecord(res.artifact)
        state.artifactPreview = {
          artifactId,
          path: asRecordText(art.sourcePath) || asRecordText(art.publishedPath) || path,
          content: asRecordText(res.content),
          truncated: Boolean(res.truncated),
        }
        render()
      })
      return
    }

    const inboxInspectBtn = target.closest<HTMLElement>("[data-inbox-inspect-task]")
    if (inboxInspectBtn?.dataset.inboxInspectTask) {
      state.artifactPreview = null
      state.inboxSelectedTaskId = inboxInspectBtn.dataset.inboxInspectTask
      render()
      return
    }

    const approveBtn = target.closest<HTMLElement>("[data-inbox-approve]")
    if (approveBtn?.dataset.inboxApprove) {
      const approvalId = approveBtn.dataset.inboxApprove
      runAction(() => runManagementOp({ op: "resolveApproval", approvalId, approve: true }, "Approved."))
      return
    }

    const rejectBtn = target.closest<HTMLElement>("[data-inbox-reject]")
    if (rejectBtn?.dataset.inboxReject) {
      const approvalId = rejectBtn.dataset.inboxReject
      runAction(() => runManagementOp({ op: "resolveApproval", approvalId, approve: false }, "Rejected."))
      return
    }

    const stopRunBtn = target.closest<HTMLElement>("[data-inbox-stop-run]")
    if (stopRunBtn?.dataset.inboxStopRun) {
      const runId = stopRunBtn.dataset.inboxStopRun
      runAction(() => runManagementOp({ op: "cancelRun", runId }, "Run stop requested."))
      return
    }

    const resolveRunBtn = target.closest<HTMLElement>("[data-inbox-resolve-run]")
    if (resolveRunBtn?.dataset.inboxResolveRun) {
      const runId = resolveRunBtn.dataset.inboxResolveRun
      runAction(() =>
        runManagementOp({ op: "resolveRun", runId, confirmStopped: true }, "Unconfirmed run marked stopped."),
      )
      return
    }

    const dismissNoticeBtn = target.closest<HTMLElement>("[data-inbox-dismiss-notice]")
    if (dismissNoticeBtn?.dataset.inboxDismissNotice) {
      const noticeId = dismissNoticeBtn.dataset.inboxDismissNotice
      runAction(() => runManagementOp({ op: "dismissNotice", noticeId }))
      return
    }

    const readLogBtn = target.closest<HTMLElement>("[data-bg-read-log]")
    if (readLogBtn?.dataset.bgReadLog) {
      const logTarget = readLogBtn.dataset.bgReadLog === "runtime" ? "runtime" : "service"
      runAction(async () => {
        const res = await runManagementOp({ op: "serviceLog", target: logTarget })
        const lines = Array.isArray(res.lines) ? res.lines.join("\n") : asRecordText(res.log)
        state.serviceLogView = {
          title: logTarget === "runtime" ? "Shared Python Runtime Log" : "Management Service Log",
          content: lines || "(Log is empty)",
        }
        render()
      })
      return
    }

    if (target.closest("[data-bg-close-log]")) {
      state.serviceLogView = null
      render()
    }
  }

  const handleContainerChange = (event: Event) => {
    const target = event.target as HTMLElement
    if (target instanceof HTMLSelectElement && target.dataset.taskPriority) {
      const taskId = target.dataset.taskPriority
      const priority = target.value
      runAction(() => runManagementOp({ op: "setTaskPriority", taskId, priority }, "Priority updated."))
    }
  }

  const handleContainerSubmit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement
    if (!form) return

    if (form.id === "sidebar-new-team-form") {
      event.preventDefault()
      const input = document.getElementById("sidebar-new-team-name") as HTMLInputElement | null
      const name = input?.value.trim() || ""
      if (!name) return
      runAction(async () => {
        const res = await runManagementOp(
          {
            op: "createTeam",
            name,
            createRoot: state.chatProjectPath || state.fallbackProjectPath || undefined,
          },
          `Team "${name}" created.`,
        )
        state.newTeamOpen = false
        const createdTeam = asRecord(res.team)
        if (typeof createdTeam.id === "string" && createdTeam.id) {
          openTeamSurface(createdTeam.id, "organization")
        } else {
          render()
        }
      })
      return
    }

    if (form.id === "agent-delete-team-form" && state.agentSurface.kind === "team") {
      event.preventDefault()
      const teamId = form.dataset.teamId || state.agentSurface.teamId
      const data = new FormData(form)
      const confirmName = String(data.get("confirmName") || "").trim()
      if (!confirmName) return
      runAction(async () => {
        await runManagementOp({ op: "deleteTeam", teamId, confirmName }, "Team deleted and archived.")
        state.agentSurface = { kind: "chat" }
        render()
      })
      return
    }

    if (form.id === "agent-add-member-form" && state.agentSurface.kind === "team") {
      event.preventDefault()
      const teamId = form.dataset.teamId || state.agentSurface.teamId
      const data = new FormData(form)
      const mode = state.agentSurface.memberMode
      const name = String(data.get("name") || "").trim()
      const position = String(data.get("position") || "").trim()
      const responsibility = String(data.get("responsibility") || "").trim()
      const reportsToAgentId = String(data.get("reportsToAgentId") || "").trim()

      let payload: Record<string, unknown>
      if (mode === "worktree") {
        payload = {
          op: "createWorktree",
          teamId,
          name,
          repository: String(data.get("repository") || "").trim() || state.chatProjectPath || undefined,
          branch: String(data.get("branch") || "").trim() || undefined,
          position: position || undefined,
          responsibility: responsibility || undefined,
          reportsToAgentId: reportsToAgentId || undefined,
        }
      } else if (mode === "existing") {
        payload = {
          op: "addMember",
          teamId,
          name: name || undefined,
          workspace: String(data.get("workspace") || "").trim(),
          position: position || undefined,
          responsibility: responsibility || undefined,
          reportsToAgentId: reportsToAgentId || undefined,
        }
      } else {
        payload = {
          op: "createWorkspace",
          teamId,
          name,
          position: position || undefined,
          responsibility: responsibility || undefined,
          reportsToAgentId: reportsToAgentId || undefined,
        }
      }
      runAction(async () => {
        await runManagementOp(payload, "Member added to team.")
        if (state.agentSurface.kind === "team") {
          state.agentSurface = { ...state.agentSurface, addMemberOpen: false }
        }
        render()
      })
      return
    }

    if (form.id === "agent-assign-task-form" && state.agentSurface.kind === "team") {
      event.preventDefault()
      const teamId = form.dataset.teamId || state.agentSurface.teamId
      const data = new FormData(form)
      const brief = String(data.get("brief") || "").trim()
      const assigneeAgentId = String(data.get("assigneeAgentId") || "").trim()
      const priority = String(data.get("priority") || "normal").trim()
      if (!brief) return
      runAction(async () => {
        await runManagementOp(
          {
            op: "assignTask",
            teamId,
            assigneeAgentId: assigneeAgentId || undefined,
            brief,
            priority,
            start: true,
          },
          "Task dispatched.",
        )
        if (state.agentSurface.kind === "team") {
          state.agentSurface = {
            ...state.agentSurface,
            assignOpen: false,
            assignAgentId: "",
            tab: "tasks",
          }
        }
        render()
      })
      return
    }

    if (form.id === "agent-task-answer-form") {
      event.preventDefault()
      const taskId = form.dataset.taskId || ""
      const textarea = document.getElementById("agent-task-answer-input") as HTMLTextAreaElement | null
      const text = textarea?.value.trim() || ""
      if (!taskId || !text) return
      runAction(() =>
        runManagementOp({ op: "postTaskNote", taskId, text, answer: true }, "Answer sent and task resumed."),
      )
      return
    }

    if (form.id === "agent-task-note-form") {
      event.preventDefault()
      const taskId = form.dataset.taskId || ""
      const input = document.getElementById("agent-task-note-input") as HTMLInputElement | null
      const text = input?.value.trim() || ""
      if (!taskId || !text) return
      runAction(() => runManagementOp({ op: "postTaskNote", taskId, text, answer: false }, "Note added."))
    }
  }

  const handleDocumentPointerDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    let changed = false
    if (state.headerSessionsMenuOpen && !target.closest(".header-sessions-dropdown-wrap")) {
      state.headerSessionsMenuOpen = false
      changed = true
    }
    if (state.agentItemMenuKey && !target.closest(".project-menu-wrap")) {
      state.agentItemMenuKey = ""
      changed = true
    }
    if (
      (state.sessionMenuId || state.sessionDeleteConfirmId) &&
      !target.closest(".session-menu-wrap") &&
      state.sidebarMode === "agents"
    ) {
      resetAgentSessionDeleteConfirm()
      state.sessionMenuId = ""
      changed = true
    }
    if (changed) {
      render()
    }
  }

  sidebarModeSwitcher.addEventListener("click", handleModeClick)
  sidebarAgents.addEventListener("click", handleContainerClick)
  sidebarAgents.addEventListener("submit", handleContainerSubmit)
  sessionAgentContext.addEventListener("click", handleContainerClick)
  agentsSurface.addEventListener("click", handleContainerClick)
  agentsSurface.addEventListener("change", handleContainerChange)
  agentsSurface.addEventListener("submit", handleContainerSubmit)
  document.addEventListener("pointerdown", handleDocumentPointerDown)

  let unsubscribe = () => {}
  if (window.api.agents) {
    unsubscribe = window.api.agents.subscribe((payload) => {
      const record = asRecord(payload)
      if (record.snapshot) {
        state.agentsSnapshot = normalizeAgentsSnapshot(record.snapshot)
      }
      if (record.service && typeof record.service === "object") {
        state.agentsService = record.service as Record<string, any>
      }
      scheduleRender()
    })
  }

  return () => {
    unsubscribe()
    sidebarModeSwitcher.removeEventListener("click", handleModeClick)
    sidebarAgents.removeEventListener("click", handleContainerClick)
    sidebarAgents.removeEventListener("submit", handleContainerSubmit)
    sessionAgentContext.removeEventListener("click", handleContainerClick)
    agentsSurface.removeEventListener("click", handleContainerClick)
    agentsSurface.removeEventListener("change", handleContainerChange)
    agentsSurface.removeEventListener("submit", handleContainerSubmit)
    document.removeEventListener("pointerdown", handleDocumentPointerDown)
  }
}
