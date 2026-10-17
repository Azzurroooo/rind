import { describe, expect, it } from "vitest";
import {
  activeBackgroundCount,
  buildInboxItems,
  buildTeamSummary,
  groupTeamTasks,
  inboxBadgeCount,
  memberStatusTone,
  resolveSessionAgentContext,
  taskColumnKey,
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
      brief: "Implement Kanban columns",
      status: "blocked",
      blockedOn: { responder: "user", action: "Confirm column labels" },
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
        artifacts: ["syntax.md"],
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
        artifacts: [],
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
      taskId: "t-running",
      status: "running",
      startedAt: "2026-10-17T10:30:00Z",
    },
    {
      id: "run-unknown",
      sessionId: "ms-2",
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
  ],
  live: [
    {
      id: "rs-fe-1",
      workspace: "E:/teams/core/frontend",
      turn: "running",
      background: { count: 2, commands: ["npm test", "npm run build"] },
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
      text: "Need confirmation on column names.",
      createdAt: "2026-10-17T11:02:00Z",
    },
  ],
  artifacts: [
    {
      id: "art-1",
      taskId: "t-done-unreviewed",
      name: "syntax.md",
      file: "E:/teams/core/frontend/syntax.md",
      size: 2048,
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

  it("builds a hierarchical org tree starting from the leader", () => {
    const summary = buildTeamSummary(sampleSnapshot, "team-1");
    expect(summary).not.toBeNull();
    expect(summary.leader.name).toBe("lead-architect");
    expect(summary.orgRoots).toHaveLength(1);
    const root = summary.orgRoots[0];
    expect(root.agentId).toBe("agent-lead");
    expect(root.children).toHaveLength(1);
    expect(root.children[0].agentId).toBe("agent-fe");
    expect(root.children[0].children).toHaveLength(1);
    expect(root.children[0].children[0].agentId).toBe("agent-qa");
    expect(summary.counts).toEqual({
      members: 3,
      working: 1,
      attention: 1,
      tasksTotal: 5,
      tasksQueued: 1,
      tasksInProgress: 1,
      tasksAttention: 2,
      tasksCompleted: 1,
    });
  });

  it("groups tasks into the 4 semantic Kanban columns", () => {
    const grouped = groupTeamTasks(sampleSnapshot, "team-1");
    expect(grouped.columns.queued.map((t) => t.id)).toEqual(["t-queued"]);
    expect(grouped.columns.in_progress.map((t) => t.id)).toEqual(["t-running"]);
    expect(grouped.columns.needs_attention.map((t) => t.id)).toEqual([
      "t-done-unreviewed",
      "t-blocked-user",
    ]);
    expect(grouped.columns.completed.map((t) => t.id)).toEqual(["t-done-accepted"]);
    expect(taskColumnKey({ status: "blocked", blockedOn: { responder: "children" } })).toBe("in_progress");
  });

  it("builds actionable inbox items and badge counts", () => {
    const items = buildInboxItems(sampleSnapshot);
    expect(items.map((i) => i.kind)).toEqual([
      "approval",
      "blocker",
      "delivery",
      "unconfirmed_run",
      "notice",
    ]);
    expect(inboxBadgeCount(sampleSnapshot)).toBe(5);
    expect(activeBackgroundCount(sampleSnapshot)).toBe(4); // 2 active/unknown runs + 2 live background jobs
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
      "rs-mgr",
      "C:/Users/admin/.rind/agents/manager",
    );
    expect(managerCtx.kind).toBe("manager");

    const indCtx = resolveSessionAgentContext(sampleSnapshot, "rs-other", "E:/other/repo");
    expect(indCtx.kind).toBe("independent");
  });
});
