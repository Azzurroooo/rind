import { describe, expect, it } from "vitest";
import {
  activeBackgroundCount,
  buildBackgroundModel,
  buildInboxItems,
  buildInboxSections,
  buildTeamSummary,
  groupTeamTasks,
  inboxBadgeCount,
  memberStatusTone,
  mergeManagerSessions,
  mergeTeamSessions,
  resolveSessionAgentContext,
  taskSectionKey,
} from "./agentsModel.js";

const sampleSnapshot = {
  seq: 12,
  teams: [
    {
      id: "team-1",
      name: "Core Product",
      leaderAgentId: "agent-lead",
      createRoot: "E:/teams/core",
    },
  ],
  agents: [
    {
      id: "agent-lead",
      name: "lead-architect",
      canonicalWorkspace: "E:/teams/core/lead",
      adapter: "rind",
    },
    {
      id: "agent-fe",
      name: "frontend-dev",
      canonicalWorkspace: "E:/teams/core/frontend",
      adapter: "rind",
      worktreeOf: "E:/teams/core",
    },
    {
      id: "agent-qa",
      name: "qa-specialist",
      canonicalWorkspace: "E:/teams/core/qa",
      adapter: "rind",
    },
    {
      id: "agent-mgr",
      name: "manager",
      canonicalWorkspace: "C:/Users/admin/.rind/agents/manager",
      adapter: "rind",
    },
  ],
  memberships: [
    {
      teamId: "team-1",
      agentId: "agent-lead",
      position: "Engineering Lead",
      responsibility: "Architecture & final delivery",
      status: "Working",
    },
    {
      teamId: "team-1",
      agentId: "agent-fe",
      reportsToAgentId: "agent-lead",
      position: "Frontend Engineer",
      responsibility: "React & Electron UI",
      status: "Needs input",
    },
    {
      teamId: "team-1",
      agentId: "agent-qa",
      reportsToAgentId: "agent-fe",
      position: "QA Automation",
      responsibility: "End-to-end verification",
      status: "Idle",
    },
  ],
  tasks: [
    {
      id: "t-queued",
      teamId: "team-1",
      assigneeAgentId: "agent-qa",
      createdBy: "manager",
      brief: "Write E2E tests",
      status: "queued",
      priority: "low",
    },
    {
      id: "t-running",
      teamId: "team-1",
      assigneeAgentId: "agent-lead",
      createdBy: "user",
      brief: "Design org hierarchy view",
      status: "running",
      priority: "high",
    },
    {
      id: "t-blocked-user",
      teamId: "team-1",
      assigneeAgentId: "agent-fe",
      createdBy: "manager",
      brief: "Implement task sections",
      status: "blocked",
      blockedOn: { responder: "user", action: "Confirm section labels" },
    },
    {
      id: "t-delegated",
      teamId: "team-1",
      assigneeAgentId: "agent-lead",
      createdBy: "user",
      brief: "Coordinate UI polish",
      status: "blocked",
      blockedOn: { responder: "children", childTaskIds: ["t-running"] },
    },
    {
      id: "t-done-unreviewed",
      teamId: "team-1",
      assigneeAgentId: "agent-fe",
      createdBy: "manager",
      brief: "Build syntax highlighter",
      status: "done",
      report: {
        outcome: "Delivered",
        summary: "Added token highlighter with copy button.",
        evidence: ["Vitest 390/390 green"],
        files: [{ label: "syntax.md", sourcePath: "E:/teams/core/frontend/syntax.md" }],
      },
    },
    {
      id: "t-done-accepted",
      teamId: "team-1",
      assigneeAgentId: "agent-lead",
      createdBy: "user",
      brief: "Protocol alignment",
      status: "done",
      report: {
        outcome: "Completed",
        summary: "Aligned protocol methods.",
        evidence: [],
        files: [],
      },
      review: { decision: "accepted", at: "2026-10-17T10:00:00Z" },
    },
  ],
  approvals: [
    {
      id: "app-1",
      kind: "cancelRun",
      teamId: "team-1",
      runId: "run-1",
      title: "Cancel hung run",
      requestedBy: "manager",
      createdAt: "2026-10-17T11:00:00Z",
    },
  ],
  runs: [
    {
      id: "run-1",
      sessionId: "ms-1",
      agentId: "agent-lead",
      taskId: "t-running",
      runtimeSessionId: "rs-lead-run",
      status: "running",
      startedAt: "2026-10-17T10:30:00Z",
    },
    {
      id: "run-unknown",
      sessionId: "ms-2",
      agentId: "agent-fe",
      status: "unknown",
      startedAt: "2026-10-17T09:00:00Z",
    },
  ],
  sessions: [
    {
      id: "ms-fe",
      agentId: "agent-fe",
      teamId: "team-1",
      runtimeSessionId: "rs-fe-1",
      origin: "direct",
      status: "active",
    },
    {
      id: "ms-mgr",
      agentId: "agent-mgr",
      runtimeSessionId: "rs-mgr-1",
      origin: "direct",
      status: "active",
    },
  ],
  connectedSessions: ["rs-fe-1"],
  live: [
    {
      runtimeSessionId: "rs-fe-1",
      workspace: "E:/teams/core/frontend",
      turnStatus: "running",
      background: { count: 2, commands: ["npm test", "npm run build"] },
      lastPreview: "Updating components",
    },
  ],
  notices: [
    {
      id: "not-1",
      teamId: "team-1",
      agentId: "agent-lead",
      title: "Team structure updated",
      createdAt: "2026-10-17T11:05:00Z",
    },
  ],
  notes: [
    {
      id: "note-1",
      taskId: "t-blocked-user",
      author: "frontend-dev",
      text: "Need confirmation on section names.",
      createdAt: "2026-10-17T11:02:00Z",
    },
  ],
  artifacts: [
    {
      id: "art-1",
      taskId: "t-done-unreviewed",
      label: "syntax.md",
      sourcePath: "E:/teams/core/frontend/syntax.md",
    },
  ],
};

describe("agentsModel", () => {
  it("maps member statuses to semantic tones", () => {
    expect(memberStatusTone("Working")).toBe("working");
    expect(memberStatusTone("Running job")).toBe("working");
    expect(memberStatusTone("Needs input")).toBe("attention");
    expect(memberStatusTone("Unconfirmed")).toBe("attention");
    expect(memberStatusTone("Delegated")).toBe("waiting");
    expect(memberStatusTone("Idle")).toBe("idle");
  });

  it("merges saved member and manager session histories with live snapshot status", () => {
    const savedTeamSessions = [
      {
        runtimeSessionId: "rs-fe-old",
        managementSessionId: "ms-fe-old",
        teamId: "team-1",
        agentId: "agent-fe",
        title: "Previous UI refactor",
        updatedAt: "2026-10-16T08:00:00Z",
      },
      {
        runtimeSessionId: "rs-fe-1",
        managementSessionId: "ms-fe",
        teamId: "team-1",
        agentId: "agent-fe",
        title: "Live frontend session",
        updatedAt: "2026-10-17T11:10:00Z",
      },
    ];
    const teamSessions = mergeTeamSessions(sampleSnapshot, "team-1", savedTeamSessions);
    const feSessions = teamSessions.filter((s) => s.agentId === "agent-fe");
    expect(feSessions).toHaveLength(2);
    expect(feSessions[0].runtimeSessionId).toBe("rs-fe-1");
    expect(feSessions[0].status).toBe("Working");
    expect(feSessions[1].runtimeSessionId).toBe("rs-fe-old");

    const mgrState = mergeManagerSessions(sampleSnapshot, [
      {
        runtimeSessionId: "rs-mgr-0",
        title: "Initial org setup",
        updatedAt: "2026-10-15T10:00:00Z",
      },
    ]);
    expect(mgrState.sessions.map((s) => s.runtimeSessionId)).toContain("rs-mgr-0");
    expect(mgrState.sessions.map((s) => s.runtimeSessionId)).toContain("rs-mgr-1");
  });

  it("builds a hierarchical org tree with member session lists and accurate counts", () => {
    const summary = buildTeamSummary(sampleSnapshot, "team-1", [
      {
        runtimeSessionId: "rs-fe-1",
        teamId: "team-1",
        agentId: "agent-fe",
        title: "Frontend session",
        updatedAt: "2026-10-17T11:10:00Z",
      },
    ]);
    expect(summary).not.toBeNull();
    expect(summary.leader.name).toBe("lead-architect");
    expect(summary.orgRoots).toHaveLength(1);
    const root = summary.orgRoots[0];
    expect(root.agentId).toBe("agent-lead");
    expect(root.children).toHaveLength(1);
    expect(root.children[0].agentId).toBe("agent-fe");
    expect(root.children[0].sessionCount).toBe(1);
    expect(root.children[0].children).toHaveLength(1);
    expect(root.children[0].children[0].agentId).toBe("agent-qa");
    expect(summary.counts).toMatchObject({
      members: 3,
      working: 1,
      attention: 3,
      tasksTotal: 6,
      tasksQueued: 1,
      tasksInProgress: 1,
      tasksDelegated: 1,
      tasksAttention: 3,
      tasksCompleted: 2,
    });
  });

  it("groups tasks into the 6 canonical action-first sections", () => {
    const grouped = groupTeamTasks(sampleSnapshot, "team-1");
    expect(grouped.groups.needs.map((t) => t.id)).toEqual(["t-blocked-user"]);
    expect(grouped.groups.working.map((t) => t.id)).toEqual(["t-running"]);
    expect(grouped.groups.queued.map((t) => t.id)).toEqual(["t-queued"]);
    expect(grouped.groups.delegated.map((t) => t.id)).toEqual(["t-delegated"]);
    expect(grouped.groups.done.map((t) => t.id)).toEqual([
      "t-done-unreviewed",
      "t-done-accepted",
    ]);
    expect(taskSectionKey({ status: "blocked", blockedOn: { responder: "children" } })).toBe("delegated");
  });

  it("builds canonical inbox sections and unified background model", () => {
    const sections = buildInboxSections(sampleSnapshot);
    expect(sections.needsYou.map((i) => i.kind)).toEqual([
      "approval",
      "blocker",
      "unconfirmed_run",
    ]);
    expect(sections.notices).toHaveLength(1);
    expect(sections.delivered).toHaveLength(2);
    expect(inboxBadgeCount(sampleSnapshot)).toBe(5);
    expect(buildInboxItems(sampleSnapshot)).toHaveLength(5);

    const bg = buildBackgroundModel(sampleSnapshot);
    expect(bg.runningNow).toHaveLength(2); // 1 running delegated run + 1 live session
    expect(bg.unconfirmedRuns).toHaveLength(1);
    expect(activeBackgroundCount(sampleSnapshot)).toBe(3);
  });

  it("resolves active session agent context from session id or workspace path", () => {
    const memberCtx = resolveSessionAgentContext(sampleSnapshot, "rs-fe-1", "");
    expect(memberCtx).toMatchObject({
      kind: "member",
      teamId: "team-1",
      teamName: "Core Product",
      agentId: "agent-fe",
      agentName: "frontend-dev",
      roleLabel: "Frontend Engineer",
    });

    const managerCtx = resolveSessionAgentContext(
      sampleSnapshot,
      "rs-mgr-1",
      "C:/Users/admin/.rind/agents/manager",
    );
    expect(managerCtx.kind).toBe("manager");

    const indCtx = resolveSessionAgentContext(sampleSnapshot, "rs-other", "E:/other/repo");
    expect(indCtx.kind).toBe("independent");
  });
});
