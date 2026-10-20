import assert from "node:assert/strict"
import test from "node:test"
import {
  activeBackgroundCount,
  buildInboxItems,
  buildInboxSections,
  buildTeamSummary,
  groupTeamTasks,
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
} from "../src/renderer/agents-model.ts"

const sampleSnapshot = normalizeAgentsSnapshot({
  seq: 12,
  teams: [
    {
      id: "team-1",
      name: "Core Platform",
      leaderAgentId: "agent-lead",
      createRoot: "/workspace/core",
    },
  ],
  agents: [
    { id: "agent-lead", name: "lead", canonicalWorkspace: "/workspace/core/lead", adapter: "rind" },
    { id: "agent-fe", name: "frontend-specialist", canonicalWorkspace: "/workspace/core/fe", adapter: "rind", worktreeOf: "/workspace/core" },
    { id: "agent-qa", name: "qa-verifier", canonicalWorkspace: "/workspace/core/qa", adapter: "rind" },
    { id: "agent-mgr", name: "manager", canonicalWorkspace: "/home/user/.rind/agents/manager", adapter: "rind" },
  ],
  memberships: [
    {
      teamId: "team-1",
      agentId: "agent-lead",
      position: "Engineering Lead",
      responsibility: "Architecture & delegation",
      status: "Working",
    },
    {
      teamId: "team-1",
      agentId: "agent-fe",
      position: "Frontend Specialist",
      responsibility: "React & Electron UI",
      reportsToAgentId: "agent-lead",
      status: "Needs input",
    },
    {
      teamId: "team-1",
      agentId: "agent-qa",
      position: "QA Engineer",
      responsibility: "End-to-end verification",
      reportsToAgentId: "agent-fe",
      status: "Idle",
    },
  ],
  tasks: [
    {
      id: "task-1",
      teamId: "team-1",
      assigneeAgentId: "agent-fe",
      brief: "Build organization chart view",
      priority: "high",
      status: "blocked",
      blockedOn: { responder: "user", action: "Should nodes collapse by default?" },
    },
    {
      id: "task-2",
      teamId: "team-1",
      assigneeAgentId: "agent-qa",
      brief: "Audit task sections accessibility",
      priority: "normal",
      status: "done",
      deliveredAt: "2026-10-17T12:00:00Z",
      report: {
        outcome: "Delivered",
        summary: "All 6 action-first task sections verified with keyboard navigation.",
        evidence: ["Tested tab order and focus rings."],
        files: [{ id: "art-1", label: "agents-model.ts", sourcePath: "desktop/src/renderer/agents-model.ts" }],
      },
    },
    {
      id: "task-3",
      teamId: "team-1",
      assigneeAgentId: "agent-lead",
      brief: "Coordinate sprint backlog",
      priority: "normal",
      status: "running",
    },
  ],
  runs: [
    { id: "run-1", taskId: "task-3", agentId: "agent-lead", status: "running", startedAt: "2026-10-17T11:55:00Z" },
    { id: "run-2", taskId: "task-1", agentId: "agent-fe", status: "unknown", startedAt: "2026-10-17T11:40:00Z" },
  ],
  sessions: [
    { id: "ms-1", teamId: "team-1", agentId: "agent-lead", origin: "direct", runtimeSessionId: "rt-lead-1" },
    { id: "ms-mgr", agentId: "agent-mgr", origin: "direct", runtimeSessionId: "rt-mgr-1" },
  ],
  approvals: [
    { id: "app-1", kind: "deleteTeam", teamId: "team-1", title: "Approve archiving legacy team", createdAt: "2026-10-17T11:30:00Z" },
  ],
  notices: [
    { id: "not-1", teamId: "team-1", agentId: "agent-qa", title: "Delivery submitted for task-2" },
  ],
  notes: [
    { id: "note-1", taskId: "task-2", author: "lead", text: "Looks solid, ready for final sign-off." },
  ],
  artifacts: [
    { id: "art-1", taskId: "task-2", label: "agents-model.ts", sourcePath: "desktop/src/renderer/agents-model.ts" },
  ],
})

test("buildTeamSummary builds multi-level org hierarchy, merges member sessions, and computes accurate counts", () => {
  const savedSessions = [
    {
      runtimeSessionId: "rt-lead-1",
      managementSessionId: "ms-1",
      teamId: "team-1",
      agentId: "agent-lead",
      title: "Architecture kickoff",
      updatedAt: "2026-10-17T12:00:00Z",
    },
    {
      runtimeSessionId: "rt-lead-0",
      managementSessionId: "ms-0",
      teamId: "team-1",
      agentId: "agent-lead",
      title: "Initial design review",
      updatedAt: "2026-10-16T10:00:00Z",
    },
  ]
  const summary = buildTeamSummary(sampleSnapshot, "team-1", savedSessions)
  assert.ok(summary)
  assert.equal(summary.team.name, "Core Platform")
  assert.equal(summary.counts.members, 3)
  assert.equal(summary.orgRoots.length, 1)
  assert.equal(summary.orgRoots[0].agentId, "agent-lead")
  assert.equal(summary.orgRoots[0].sessionCount, 2)
  assert.equal(summary.orgRoots[0].children.length, 1)
  assert.equal(summary.orgRoots[0].children[0].agentId, "agent-fe")
  assert.equal(summary.orgRoots[0].children[0].children[0].agentId, "agent-qa")

  const byAgent = mergeTeamSessions(sampleSnapshot, "team-1", savedSessions)
  assert.equal(byAgent.get("agent-lead")?.length, 2)
  const mgrSessions = mergeManagerSessions(sampleSnapshot, [])
  assert.equal(mgrSessions.length, 1)
})

test("groupTeamTasks categorizes tasks into 6 action-first sections", () => {
  const grouped = groupTeamTasks(sampleSnapshot, "team-1")
  assert.equal(grouped.all.length, 3)
  assert.equal(grouped.sections.needs.length, 2)
  assert.equal(grouped.sections.working.length, 1)
  assert.equal(grouped.sections.done.length, 0)
})

test("buildInboxSections aggregates Needs you, Changed by the Manager, and Recently delivered", () => {
  const sections = buildInboxSections(sampleSnapshot)
  assert.equal(sections.needsYou.length, 4)
  assert.equal(sections.notices.length, 1)
  assert.equal(inboxBadgeCount(sampleSnapshot), 5)
  assert.equal(buildInboxItems(sampleSnapshot).length, 5)
  assert.equal(activeBackgroundCount(sampleSnapshot), 2)
})

test("resolveSessionAgentContext identifies team member, manager, and independent sessions", () => {
  const leadCtx = resolveSessionAgentContext(sampleSnapshot, "rt-lead-1", "/workspace/core/lead")
  assert.equal(leadCtx.kind, "member")
  if (leadCtx.kind === "member") {
    assert.equal(leadCtx.teamName, "Core Platform")
    assert.equal(leadCtx.isLeader, true)
  }

  const workspaceOnlyMemberCtx = resolveSessionAgentContext(sampleSnapshot, "", "/workspace/core/fe")
  assert.equal(workspaceOnlyMemberCtx.kind, "member")
  if (workspaceOnlyMemberCtx.kind === "member") {
    assert.equal(workspaceOnlyMemberCtx.agentId, "agent-fe")
    assert.equal(workspaceOnlyMemberCtx.teamId, "team-1")
  }

  const managerCtx = resolveSessionAgentContext(sampleSnapshot, "rt-mgr-1", "/home/user/.rind/agents/manager")
  assert.equal(managerCtx.kind, "manager")

  const workspaceOnlyManagerCtx = resolveSessionAgentContext(sampleSnapshot, "", "/home/user/.rind/agents/manager")
  assert.equal(workspaceOnlyManagerCtx.kind, "manager")

  const indepCtx = resolveSessionAgentContext(sampleSnapshot, "rt-other", "/workspace/my-app")
  assert.equal(indepCtx.kind, "independent")
})

test("pure HTML renderers produce accessible markup for sidebar, team, task drawer, manager, inbox, background, archive, and header sessions switcher", () => {
  const sixLeadSessions = Array.from({ length: 6 }, (_, idx) => ({
    runtimeSessionId: `rt-lead-${idx + 1}`,
    teamId: "team-1",
    agentId: "agent-lead",
    title: idx === 0 ? "Architecture kickoff" : `Session ${idx + 1}`,
    updatedAt: `2026-10-17T1${5 - idx}:00:00Z`,
  }))
  const sidebarHtml = renderSidebarAgentsHtml({
    snapshot: sampleSnapshot,
    surface: { kind: "chat" },
    chatContext: { kind: "independent" },
    collapsedTeams: new Set(),
    expandedSidebarMembers: new Set(["team-1:agent-lead"]),
    managerExpanded: true,
    teamSessionsByTeam: {
      "team-1": sixLeadSessions,
    },
    newTeamOpen: true,
    busy: false,
  })
  assert.match(sidebarHtml, /Inbox/)
  assert.match(sidebarHtml, /Manager/)
  assert.match(sidebarHtml, /Core Platform/)
  assert.match(sidebarHtml, /frontend-specialist/)
  assert.match(sidebarHtml, /qa-verifier/)
  assert.match(sidebarHtml, /Architecture kickoff/)
  assert.match(sidebarHtml, /session-item-row/)
  assert.match(sidebarHtml, /session-menu-trigger/)
  assert.match(sidebarHtml, /View more sessions/)
  assert.match(sidebarHtml, /team-trigger-meta">3 members</)
  assert.match(sidebarHtml, /sidebar-org-children" role="group" aria-label="Direct reports of lead"/)
  assert.match(sidebarHtml, /sidebar-org-children" role="group" aria-label="Direct reports of frontend-specialist"/)
  assert.doesNotMatch(sidebarHtml, /project-path/)
  assert.doesNotMatch(sidebarHtml, /Engineering Lead/)
  assert.doesNotMatch(sidebarHtml, /Frontend Specialist/)
  assert.doesNotMatch(sidebarHtml, /Organization coordinator ·/)
  assert.doesNotMatch(sidebarHtml, /3 tasks/)
  assert.doesNotMatch(sidebarHtml, /Session 6/)
  assert.doesNotMatch(sidebarHtml, />Board</)
  assert.doesNotMatch(sidebarHtml, />Coord</)
  assert.doesNotMatch(sidebarHtml, />Overview</)
  assert.doesNotMatch(sidebarHtml, /project-action-pill/)

  const collapsedSidebarHtml = renderSidebarAgentsHtml({
    snapshot: sampleSnapshot,
    surface: { kind: "chat" },
    chatContext: { kind: "independent" },
    collapsedTeams: new Set(["team-1"]),
    expandedSidebarMembers: new Set(),
    managerExpanded: false,
    teamSessionsByTeam: {},
    newTeamOpen: false,
    busy: false,
  })
  assert.doesNotMatch(collapsedSidebarHtml, /team-trigger-meta/)
  assert.doesNotMatch(collapsedSidebarHtml, /3 members/)

  const teamOrgHtml = renderTeamSurfaceHtml({
    snapshot: sampleSnapshot,
    surface: {
      kind: "team",
      teamId: "team-1",
      tab: "organization",
      assigneeFilter: "",
      selectedTaskId: "task-2",
      addMemberOpen: true,
      memberMode: "worktree",
      assignOpen: false,
      assignAgentId: "",
      deleteConfirmOpen: false,
    },
    teamSessions: [
      {
        runtimeSessionId: "rt-lead-1",
        teamId: "team-1",
        agentId: "agent-lead",
        title: "Architecture kickoff",
        updatedAt: "2026-10-17T12:00:00Z",
      },
    ],
    expandedOrgMembers: new Set(["agent-lead"]),
    busy: false,
    artifactPreview: { artifactId: "art-1", path: "desktop/src/renderer/agents-model.ts", content: "export const ok = true", truncated: false },
  })
  assert.match(teamOrgHtml, /Engineering Lead/)
  assert.match(teamOrgHtml, /Conversations \(1\)/)
  assert.match(teamOrgHtml, /Architecture kickoff/)
  assert.match(teamOrgHtml, /Delivery Report/)
  assert.match(teamOrgHtml, /Accept Delivery/)
  assert.match(teamOrgHtml, /Source Git Repository/)

  const teamTasksHtml = renderTeamSurfaceHtml({
    snapshot: sampleSnapshot,
    surface: {
      kind: "team",
      teamId: "team-1",
      tab: "tasks",
      assigneeFilter: "",
      selectedTaskId: "task-1",
      addMemberOpen: false,
      memberMode: "workspace",
      assignOpen: true,
      assignAgentId: "agent-fe",
      deleteConfirmOpen: false,
    },
    busy: false,
    artifactPreview: null,
  })
  assert.match(teamTasksHtml, /Needs you/)
  assert.match(teamTasksHtml, /In progress/)
  assert.match(teamTasksHtml, /Should nodes collapse by default\?/)
  assert.match(teamTasksHtml, /Send Answer &amp; Resume/)
  assert.doesNotMatch(teamTasksHtml, /agent-kanban-grid/)

  const inboxHtml = renderInboxSurfaceHtml({
    snapshot: sampleSnapshot,
    selectedTaskId: "task-2",
    busy: false,
    artifactPreview: null,
  })
  assert.match(inboxHtml, /Approve archiving legacy team/)
  assert.match(inboxHtml, /Delivery Ready for Review/)
  assert.match(inboxHtml, /Changed by the Manager/)

  const mgrHtml = renderManagerSurfaceHtml({
    snapshot: sampleSnapshot,
    managerSessions: [],
    busy: false,
  })
  assert.match(mgrHtml, /Organization Coordinator/)
  assert.match(mgrHtml, /Manager Conversations/)

  const bgHtml = renderBackgroundSurfaceHtml({
    snapshot: sampleSnapshot,
    serviceInfo: { service: { pid: 4321 }, runtime: { host: "127.0.0.1", port: 8900 } },
    logView: { title: "Management Service Log", content: "Service healthy" },
    busy: false,
  })
  assert.match(bgHtml, /Running \(PID 4321\)/)
  assert.match(bgHtml, /127\.0\.0\.1:8900/)
  assert.match(bgHtml, /Service healthy/)

  const archiveHtml = renderArchiveSurfaceHtml({
    snapshot: sampleSnapshot,
    archivedTeams: [{ id: "arch-1", name: "Legacy Team", deletedAt: "2026-10-16T00:00:00Z" }],
  })
  assert.match(archiveHtml, /Legacy Team/)

  const breadcrumbHtml = renderHeaderAgentBreadcrumbHtml(
    {
      kind: "member",
      teamId: "team-1",
      teamName: "Core Platform",
      agentId: "agent-lead",
      agentName: "lead",
      roleLabel: "Engineering Lead",
      isLeader: true,
      status: "Working",
    },
    {
      sessions: [
        {
          runtimeSessionId: "rt-lead-1",
          managementSessionId: "ms-1",
          workspaceRoot: "/workspace/core/lead",
          origin: "direct",
          taskId: "",
          title: "Architecture kickoff",
          updatedAt: "2026-10-17T12:00:00Z",
          createdAt: "2026-10-17T11:00:00Z",
          model: "",
          status: "Working",
          tone: "working",
          connected: true,
          live: null,
        },
      ],
      viewedSessionId: "rt-lead-1",
      menuOpen: true,
    },
  )
  assert.match(breadcrumbHtml, /Core Platform/)
  assert.match(breadcrumbHtml, />lead</)
  assert.doesNotMatch(breadcrumbHtml, /Engineering Lead/)
  assert.match(breadcrumbHtml, /Sessions \(1\)/)
  assert.match(breadcrumbHtml, /Architecture kickoff/)

  const customWidthDrawerHtml = renderTeamSurfaceHtml({
    snapshot: sampleSnapshot,
    surface: {
      kind: "team",
      teamId: "team-1",
      tab: "tasks",
      assigneeFilter: "",
      selectedTaskId: "task-2",
      addMemberOpen: false,
      memberMode: "workspace",
      assignOpen: false,
      assignAgentId: "",
      deleteConfirmOpen: false,
    },
    busy: false,
    artifactPreview: null,
    drawerWidth: 560,
    drawerExpanded: false,
  })
  assert.match(customWidthDrawerHtml, /data-task-drawer-resize="1"/)
  assert.match(customWidthDrawerHtml, /data-task-drawer-expand="1"/)
  assert.match(customWidthDrawerHtml, /style="width: 560px;"/)

  const expandedDrawerHtml = renderInboxSurfaceHtml({
    snapshot: sampleSnapshot,
    selectedTaskId: "task-2",
    busy: false,
    artifactPreview: null,
    drawerWidth: 560,
    drawerExpanded: true,
  })
  assert.match(expandedDrawerHtml, /agent-task-drawer is-expanded/)
  assert.match(expandedDrawerHtml, /Restore panel width/)

  const memberMenuOpenOrgHtml = renderTeamSurfaceHtml({
    snapshot: sampleSnapshot,
    surface: {
      kind: "team",
      teamId: "team-1",
      tab: "organization",
      assigneeFilter: "",
      selectedTaskId: "",
      addMemberOpen: false,
      memberMode: "workspace",
      assignOpen: false,
      assignAgentId: "",
      deleteConfirmOpen: false,
    },
    itemMenuKey: "org-member:agent-fe",
    busy: false,
    artifactPreview: null,
  })
  assert.match(memberMenuOpenOrgHtml, /org-member-card menu-open/)
  assert.match(memberMenuOpenOrgHtml, /project-menu-wrap menu-open/)
  assert.doesNotMatch(memberMenuOpenOrgHtml, /Make leader/)
  assert.doesNotMatch(memberMenuOpenOrgHtml, /data-agent-make-leader/)

  const sidebarMemberMenuOpenHtml = renderSidebarAgentsHtml({
    snapshot: sampleSnapshot,
    surface: { kind: "chat" },
    chatContext: { kind: "independent" },
    collapsedTeams: new Set(),
    expandedSidebarMembers: new Set(["team-1:agent-fe"]),
    managerExpanded: false,
    teamSessionsByTeam: { "team-1": sixLeadSessions },
    itemMenuKey: "member:team-1:agent-fe",
    sessionMenuId: "member:team-1:agent-lead:rt-lead-1",
    busy: false,
  })
  assert.match(sidebarMemberMenuOpenHtml, /sidebar-org-branch menu-open/)
  assert.match(sidebarMemberMenuOpenHtml, /team-project-item expanded menu-open/)
  assert.match(sidebarMemberMenuOpenHtml, /team-members-group menu-open/)
  assert.match(sidebarMemberMenuOpenHtml, /member-project-item expanded menu-open|member-project-item menu-open/)
  assert.doesNotMatch(sidebarMemberMenuOpenHtml, /Make leader/)
  assert.doesNotMatch(sidebarMemberMenuOpenHtml, /data-agent-make-leader/)

  const sidebarTeamMenuOpenHtml = renderSidebarAgentsHtml({
    snapshot: sampleSnapshot,
    surface: { kind: "chat" },
    chatContext: { kind: "independent" },
    collapsedTeams: new Set(),
    expandedSidebarMembers: new Set(["team-1:agent-lead", "team-1:agent-fe"]),
    managerExpanded: true,
    teamSessionsByTeam: { "team-1": sixLeadSessions },
    itemMenuKey: "team:team-1",
    newTeamOpen: false,
    busy: false,
  })
  assert.match(sidebarTeamMenuOpenHtml, /team-project-item expanded menu-open/)
  assert.doesNotMatch(sidebarTeamMenuOpenHtml, /sidebar-org-branch menu-open/)
  assert.doesNotMatch(sidebarTeamMenuOpenHtml, /member-project-item[^"]*menu-open/)
})


