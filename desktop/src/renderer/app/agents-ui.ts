import {
  normalizeAgentsSnapshot,
  renderBackgroundSurfaceHtml,
  renderHeaderAgentBreadcrumbHtml,
  renderInboxSurfaceHtml,
  renderInspectorTeamSectionHtml,
  renderSidebarAgentsHtml,
  renderTeamSurfaceHtml,
  resolveSessionAgentContext,
  type SessionAgentContext,
} from "../agents-model.ts"
import { createConversation } from "../timeline-model.ts"
import {
  agentsSurface,
  composerRegion,
  inspectorTeamPanel,
  prompt,
  sessionAgentContext,
  sidebarAgents,
  streamWrap,
} from "./dom.ts"
import { asRecord, asRecordText } from "./html.ts"
import { showToast } from "./overlays.ts"
import { loadReplay, resetConversationPresentation, runAction } from "./runtime.ts"
import { restoreProjectDraft } from "./sessions.ts"
import { render, scheduleRender } from "./shell.ts"
import { state } from "./state.ts"

let lastSidebarKey = ""
let lastSurfaceKey = ""

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

export function renderAgentsUI() {
  const snapshot = state.agentsSnapshot
  const chatContext = currentSessionAgentContext()
  const isAgentSurface = state.agentSurface.kind !== "chat"

  // Toggle center-stage surface vs conversation stream + composer
  agentsSurface.hidden = !isAgentSurface
  streamWrap.hidden = isAgentSurface
  if (composerRegion) composerRegion.hidden = isAgentSurface

  // Header agent context breadcrumb
  const breadcrumbHtml = renderHeaderAgentBreadcrumbHtml(chatContext)
  sessionAgentContext.innerHTML = breadcrumbHtml
  sessionAgentContext.hidden = !breadcrumbHtml || isAgentSurface

  // Sidebar navigation
  const activeSidebarInput = sidebarAgents.querySelector<HTMLInputElement>("input:focus")
  const sidebarKey = JSON.stringify({
    seq: snapshot.seq,
    surface: state.agentSurface.kind === "team" ? `team:${state.agentSurface.teamId}` : state.agentSurface.kind,
    chatKind: chatContext.kind,
    chatAgent: chatContext.kind === "member" ? chatContext.agentId : "",
    collapsed: [...state.collapsedTeams],
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
      } else if (state.agentSurface.kind === "background") {
        agentsSurface.innerHTML = renderBackgroundSurfaceHtml({
          snapshot,
          serviceInfo: state.agentsService,
          logView: state.serviceLogView,
          busy: state.agentsBusy,
        })
      }
    }
  } else {
    lastSurfaceKey = ""
  }

  // Inspector team panel (rendered inside Activity tab)
  const inspectorTeamHtml = renderInspectorTeamSectionHtml({
    snapshot,
    chatContext,
  })
  inspectorTeamPanel.innerHTML = inspectorTeamHtml
  inspectorTeamPanel.hidden = !inspectorTeamHtml
}

export function openTeamSurface(teamId: string, tab: "organization" | "tasks" = "organization", selectedTaskId = "") {
  state.artifactPreview = null
  state.agentSurface = {
    kind: "team",
    teamId,
    tab,
    taskLayout: state.agentSurface.kind === "team" ? state.agentSurface.taskLayout : "board",
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
}) {
  state.agentsBusy = true
  render()
  try {
    const opened = asRecord(
      await window.api.agents.openSession({
        manager: Boolean(options.manager),
        teamId: options.teamId,
        agentId: options.agentId,
        origin: "direct",
      }),
    )
    if (opened.snapshot) {
      state.agentsSnapshot = normalizeAgentsSnapshot(opened.snapshot)
    }
    const mgmtSession = asRecord(opened.session)
    const managementSessionId = asRecordText(mgmtSession.id)
    const workspaceRoot = asRecordText(opened.workspaceRoot) || state.chatProjectPath
    const runtimeSessionId =
      asRecordText(mgmtSession.runtimeSessionId) || String(options.existingRuntimeSessionId || "")

    if (options.manager) {
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

    state.agentSurface = { kind: "chat" }
    state.chatProjectPath = workspaceRoot
    state.viewedProjectPath = workspaceRoot

    if (runtimeSessionId) {
      state.viewedSessionId = runtimeSessionId
      state.conversation = state.conversationCache[runtimeSessionId] || createConversation()
      resetConversationPresentation()
      restoreProjectDraft()
      render()
      await loadReplay(runtimeSessionId)
      render()
    } else {
      state.viewedSessionId = ""
      state.conversation = createConversation()
      resetConversationPresentation()
      restoreProjectDraft()
      render()
    }
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
    return res
  } finally {
    state.agentsBusy = false
    render()
  }
}

export function bindAgentsEvents(): () => void {
  const handleContainerClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement

    const surfaceBtn = target.closest<HTMLElement>("[data-sidebar-surface]")
    if (surfaceBtn) {
      const next = surfaceBtn.dataset.sidebarSurface
      state.artifactPreview = null
      if (next === "inbox") state.agentSurface = { kind: "inbox" }
      else if (next === "background") state.agentSurface = { kind: "background" }
      else state.agentSurface = { kind: "chat" }
      render()
      return
    }

    if (target.closest("[data-sidebar-open-manager]")) {
      runAction(() => openManagedAgentChat({ manager: true }))
      return
    }

    const toggleNewTeamBtn = target.closest<HTMLElement>("[data-sidebar-toggle-new-team]")
    if (toggleNewTeamBtn) {
      state.newTeamOpen = !state.newTeamOpen
      render()
      return
    }

    const toggleTeamCollapseBtn = target.closest<HTMLElement>("[data-sidebar-toggle-team]")
    if (toggleTeamCollapseBtn?.dataset.sidebarToggleTeam) {
      const teamId = toggleTeamCollapseBtn.dataset.sidebarToggleTeam
      if (state.collapsedTeams.has(teamId)) state.collapsedTeams.delete(teamId)
      else state.collapsedTeams.add(teamId)
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

    const chatBtn = target.closest<HTMLElement>("[data-agent-chat]")
    if (chatBtn?.dataset.agentChat) {
      const agentId = chatBtn.dataset.agentChat
      const teamId = chatBtn.dataset.agentTeam || ""
      const existingRuntimeSessionId = chatBtn.dataset.agentSession || ""
      runAction(() =>
        openManagedAgentChat({
          teamId,
          agentId,
          existingRuntimeSessionId,
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

    const layoutBtn = target.closest<HTMLElement>("[data-team-task-layout]")
    if (layoutBtn && state.agentSurface.kind === "team") {
      const taskLayout = layoutBtn.dataset.teamTaskLayout === "list" ? "list" : "board"
      state.agentSurface = { ...state.agentSurface, taskLayout }
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

    const confirmDeleteBtn = target.closest<HTMLElement>("[data-team-confirm-delete]")
    if (confirmDeleteBtn?.dataset.teamConfirmDelete) {
      const teamId = confirmDeleteBtn.dataset.teamConfirmDelete
      const cleanupWorkspaces = confirmDeleteBtn.dataset.cleanupWorkspaces === "1"
      runAction(async () => {
        await runManagementOp({ op: "deleteTeam", teamId, cleanupWorkspaces }, "Team deleted.")
        state.agentSurface = { kind: "chat" }
        render()
      })
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

    const cancelTaskBtn = target.closest<HTMLElement>("[data-task-cancel]")
    if (cancelTaskBtn?.dataset.taskCancel) {
      const taskId = cancelTaskBtn.dataset.taskCancel
      runAction(() => runManagementOp({ op: "cancelTask", taskId }, "Task cancelled."))
      return
    }

    const reviewTaskBtn = target.closest<HTMLElement>("[data-task-review]")
    if (reviewTaskBtn?.dataset.taskReview) {
      const taskId = reviewTaskBtn.dataset.taskReview
      const decision = reviewTaskBtn.dataset.reviewDecision === "rework" ? "rework" : "accepted"
      const commentEl = document.getElementById("agent-task-review-comment") as HTMLTextAreaElement | null
      const comment = commentEl?.value.trim() || ""
      runAction(() =>
        runManagementOp(
          { op: "reviewTask", taskId, decision, comment: comment || undefined },
          decision === "accepted" ? "Delivery accepted." : "Sent back for rework.",
        ),
      )
      return
    }

    const readArtifactBtn = target.closest<HTMLElement>("[data-task-read-artifact]")
    if (readArtifactBtn?.dataset.taskReadArtifact && readArtifactBtn.dataset.artifactPath) {
      const taskId = readArtifactBtn.dataset.taskReadArtifact
      const path = readArtifactBtn.dataset.artifactPath
      if (state.artifactPreview?.path === path) {
        state.artifactPreview = null
        render()
        return
      }
      runAction(async () => {
        const res = await runManagementOp({ op: "readTaskArtifact", taskId, path })
        state.artifactPreview = {
          path: asRecordText(res.path) || path,
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
      runAction(() => runManagementOp({ op: "approve", approvalId }, "Approved."))
      return
    }

    const rejectBtn = target.closest<HTMLElement>("[data-inbox-reject]")
    if (rejectBtn?.dataset.inboxReject) {
      const approvalId = rejectBtn.dataset.inboxReject
      runAction(() => runManagementOp({ op: "reject", approvalId }, "Rejected."))
      return
    }

    const stopRunBtn = target.closest<HTMLElement>("[data-inbox-stop-run]")
    if (stopRunBtn?.dataset.inboxStopRun) {
      const runId = stopRunBtn.dataset.inboxStopRun
      runAction(() => runManagementOp({ op: "stopRun", runId }, "Run stopped."))
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
      const which = readLogBtn.dataset.bgReadLog === "runtime" ? "runtime" : "service"
      runAction(async () => {
        const res = await runManagementOp({ op: "readServiceLog", which })
        state.serviceLogView = {
          title: which === "runtime" ? "Shared Python Runtime Log" : "Management Service Log",
          content: asRecordText(res.log) || "(Log is empty)",
        }
        render()
      })
      return
    }

    const readRunLogBtn = target.closest<HTMLElement>("[data-bg-read-run-log]")
    if (readRunLogBtn?.dataset.bgReadRunLog) {
      const runId = readRunLogBtn.dataset.bgReadRunLog
      runAction(async () => {
        const res = await runManagementOp({ op: "readRunLog", runId })
        state.serviceLogView = {
          title: `Run Log · ${runId}`,
          content: asRecordText(res.log) || "(No output recorded for this run)",
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

    if (form.id === "agent-add-member-form" && state.agentSurface.kind === "team") {
      event.preventDefault()
      const teamId = form.dataset.teamId || state.agentSurface.teamId
      const data = new FormData(form)
      const mode = state.agentSurface.memberMode
      const position = String(data.get("position") || "").trim()
      const responsibility = String(data.get("responsibility") || "").trim()
      const reportsTo = String(data.get("reportsTo") || "").trim()
      const payload: Record<string, unknown> = {
        op: "addMember",
        teamId,
        position: position || undefined,
        responsibility: responsibility || undefined,
        reportsTo: reportsTo || undefined,
      }
      if (mode === "existing") {
        payload.existingAgentId = String(data.get("existingAgentId") || "").trim()
      } else {
        payload.name = String(data.get("name") || "").trim()
        if (mode === "worktree") {
          payload.worktreeFrom = String(data.get("worktreeFrom") || "").trim() || state.chatProjectPath || undefined
        } else {
          const ws = String(data.get("workspace") || "").trim()
          if (ws) payload.workspace = ws
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
      const agentId = String(data.get("agentId") || "").trim()
      const priority = String(data.get("priority") || "normal").trim()
      if (!brief) return
      runAction(async () => {
        await runManagementOp(
          {
            op: "assignTask",
            teamId,
            agentId: agentId || undefined,
            brief,
            priority,
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
      const answer = textarea?.value.trim() || ""
      if (!taskId || !answer) return
      runAction(() => runManagementOp({ op: "answerTask", taskId, answer }, "Answer sent to agent."))
      return
    }

    if (form.id === "agent-task-note-form") {
      event.preventDefault()
      const taskId = form.dataset.taskId || ""
      const input = document.getElementById("agent-task-note-input") as HTMLInputElement | null
      const text = input?.value.trim() || ""
      if (!taskId || !text) return
      runAction(() => runManagementOp({ op: "addTaskNote", taskId, text }, "Note added."))
    }
  }

  sidebarAgents.addEventListener("click", handleContainerClick)
  sidebarAgents.addEventListener("submit", handleContainerSubmit)
  sessionAgentContext.addEventListener("click", handleContainerClick)
  agentsSurface.addEventListener("click", handleContainerClick)
  agentsSurface.addEventListener("submit", handleContainerSubmit)
  inspectorTeamPanel.addEventListener("click", handleContainerClick)

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
    sidebarAgents.removeEventListener("click", handleContainerClick)
    sidebarAgents.removeEventListener("submit", handleContainerSubmit)
    sessionAgentContext.removeEventListener("click", handleContainerClick)
    agentsSurface.removeEventListener("click", handleContainerClick)
    agentsSurface.removeEventListener("submit", handleContainerSubmit)
    inspectorTeamPanel.removeEventListener("click", handleContainerClick)
  }
}
