import assert from "node:assert/strict"
import test from "node:test"
import {
  activeBackgroundCount,
  buildInboxItems,
  buildTeamSummary,
  groupTeamTasks,
  inboxBadgeCount,
  normalizeAgentsSnapshot,
  renderBackgroundSurfaceHtml,
  renderHeaderAgentBreadcrumbHtml,
  renderInboxSurfaceHtml,
  renderInspectorTeamSectionHtml,
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
      brief: "Audit Kanban accessibility",
      priority: "normal",
      status: "done",
      deliveredAt: "2026-10-17T12:00:00Z",
      report: {
        summary: "All 4 columns verified with keyboard navigation.",
        details: "Tested tab order and focus rings.",
        filesChanged: ["desktop/src/renderer/agents-model.ts"],
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
})

test("buildTeamSummary builds multi-level org hierarchy and accurate counts", () => {
  const summary = buildTeamSummary(sampleSnapshot, "team-1")
  assert.ok(summary)
  assert.equal(summary.team.name, "Core Platform")
  assert.equal(summary.counts.members, 3)
  assert.equal(summary.orgRoots.length, 1)
  assert.equal(summary.orgRoots[0].agentId, "agent-lead")
  assert.equal(summary.orgRoots[0].children.length, 1)
  assert.equal(summary.orgRoots[0].children[0].agentId, "agent-fe")
  assert.equal(summary.orgRoots[0].children[0].children[0].agentId, "agent-qa")
})

test("groupTeamTasks categorizes tasks into 4 semantic Kanban columns", () => {
  const grouped = groupTeamTasks(sampleSnapshot, "team-1")
  assert.equal(grouped.all.length, 3)
  assert.equal(grouped.columns.in_progress.length, 1)
  assert.equal(grouped.columns.needs_attention.length, 2)
  assert.equal(grouped.columns.completed.length, 0)
})

test("buildInboxItems aggregates approvals, blockers, deliveries, unconfirmed runs, and notices", () => {
  const items = buildInboxItems(sampleSnapshot)
  assert.equal(items.length, 5)
  assert.equal(inboxBadgeCount(sampleSnapshot), 5)
  assert.equal(activeBackgroundCount(sampleSnapshot), 2)
})

test("resolveSessionAgentContext identifies team member, manager, and independent sessions", () => {
  const leadCtx = resolveSessionAgentContext(sampleSnapshot, "rt-lead-1", "/workspace/core/lead")
  assert.equal(leadCtx.kind, "member")
  if (leadCtx.kind === "member") {
    assert.equal(leadCtx.teamName, "Core Platform")
    assert.equal(leadCtx.isLeader, true)
  }

  const managerCtx = resolveSessionAgentContext(sampleSnapshot, "", "/home/user/.rind/agents/manager")
  assert.equal(managerCtx.kind, "manager")

  const indepCtx = resolveSessionAgentContext(sampleSnapshot, "rt-other", "/workspace/my-app")
  assert.equal(indepCtx.kind, "independent")
})

test("pure HTML renderers produce accessible markup for sidebar, team, task drawer, inbox, background, and inspector", () => {
  const sidebarHtml = renderSidebarAgentsHtml({
    snapshot: sampleSnapshot,
    surface: { kind: "chat" },
    chatContext: { kind: "independent" },
    collapsedTeams: new Set(),
    newTeamOpen: true,
    busy: false,
  })
  assert.match(sidebarHtml, /Inbox &amp; Approvals/)
  assert.match(sidebarHtml, /Manager Agent/)
  assert.match(sidebarHtml, /Core Platform/)
  assert.match(sidebarHtml, /frontend-specialist/)

  const teamOrgHtml = renderTeamSurfaceHtml({
    snapshot: sampleSnapshot,
    surface: {
      kind: "team",
      teamId: "team-1",
      tab: "organization",
      taskLayout: "board",
      assigneeFilter: "",
      selectedTaskId: "task-2",
      addMemberOpen: true,
      memberMode: "worktree",
      assignOpen: false,
      assignAgentId: "",
      deleteConfirmOpen: false,
    },
    busy: false,
    artifactPreview: { path: "desktop/src/renderer/agents-model.ts", content: "export const ok = true", truncated: false },
  })
  assert.match(teamOrgHtml, /Engineering Lead/)
  assert.match(teamOrgHtml, /Delivery Report/)
  assert.match(teamOrgHtml, /Accept Delivery/)
  assert.match(teamOrgHtml, /Source Git Repo Path/)

  const teamTasksHtml = renderTeamSurfaceHtml({
    snapshot: sampleSnapshot,
    surface: {
      kind: "team",
      teamId: "team-1",
      tab: "tasks",
      taskLayout: "board",
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
  assert.match(teamTasksHtml, /Needs Review \/ Input/)
  assert.match(teamTasksHtml, /Should nodes collapse by default\?/)
  assert.match(teamTasksHtml, /Send Answer &amp; Resume/)

  const inboxHtml = renderInboxSurfaceHtml({
    snapshot: sampleSnapshot,
    selectedTaskId: "task-2",
    busy: false,
    artifactPreview: null,
  })
  assert.match(inboxHtml, /Approve archiving legacy team/)
  assert.match(inboxHtml, /Delivery Ready for Review/)

  const bgHtml = renderBackgroundSurfaceHtml({
    snapshot: sampleSnapshot,
    serviceInfo: { service: { pid: 4321 }, runtime: { host: "127.0.0.1", port: 8900 } },
    logView: { title: "Management Service Log", content: "Service healthy" },
    busy: false,
  })
  assert.match(bgHtml, /Running \(PID 4321\)/)
  assert.match(bgHtml, /127\.0\.0\.1:8900/)
  assert.match(bgHtml, /Service healthy/)

  const breadcrumbHtml = renderHeaderAgentBreadcrumbHtml({
    kind: "member",
    teamId: "team-1",
    teamName: "Core Platform",
    agentId: "agent-lead",
    agentName: "lead",
    roleLabel: "Engineering Lead",
    isLeader: true,
    status: "Working",
  })
  assert.match(breadcrumbHtml, /Core Platform/)
  assert.match(breadcrumbHtml, /Engineering Lead · Leader/)

  const inspectorHtml = renderInspectorTeamSectionHtml({
    snapshot: sampleSnapshot,
    chatContext: {
      kind: "member",
      teamId: "team-1",
      teamName: "Core Platform",
      agentId: "agent-lead",
      agentName: "lead",
      roleLabel: "Engineering Lead",
      isLeader: true,
      status: "Working",
    },
  })
  assert.match(inspectorHtml, /Team · Core Platform/)
  assert.match(inspectorHtml, /Build organization chart view/)
})
