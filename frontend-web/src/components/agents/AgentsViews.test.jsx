import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInboxItems, buildTeamSummary, groupTeamTasks } from "../../lib/agentsModel.js";
import { TeamView } from "./TeamView.jsx";
import { InboxView } from "./InboxView.jsx";
import { BackgroundView } from "./BackgroundView.jsx";
import { Sidebar } from "../shell/Sidebar.jsx";
import { Inspector } from "../inspector/Inspector.jsx";

afterEach(cleanup);

const mockSnapshot = {
  seq: 5,
  teams: [{ id: "team-alpha", name: "Alpha Squad", leaderAgentId: "a-1", createRoot: "E:/teams/alpha" }],
  agents: [
    { id: "a-1", name: "alpha-lead", canonicalWorkspace: "E:/teams/alpha/lead", adapter: "rind" },
    { id: "a-2", name: "ui-specialist", canonicalWorkspace: "E:/teams/alpha/ui", adapter: "rind" },
  ],
  memberships: [
    { teamId: "team-alpha", agentId: "a-1", position: "Tech Lead", responsibility: "System design", status: "Working" },
    { teamId: "team-alpha", agentId: "a-2", reportsToAgentId: "a-1", position: "UI Engineer", responsibility: "Components", status: "Needs input" },
  ],
  tasks: [
    {
      id: "task-1",
      teamId: "team-alpha",
      assigneeAgentId: "a-2",
      createdBy: "manager",
      brief: "Polish org chart connectors",
      status: "done",
      report: {
        outcome: "Delivered",
        summary: "Implemented recursive OrgMemberNode with connector rails.",
        evidence: ["All tests green"],
        artifacts: ["org-spec.md"],
      },
    },
    {
      id: "task-2",
      teamId: "team-alpha",
      assigneeAgentId: "a-2",
      createdBy: "manager",
      brief: "Confirm dark mode contrast",
      status: "blocked",
      blockedOn: { responder: "user", action: "Should warning pills use amber or terracotta?" },
    },
  ],
  approvals: [
    {
      id: "ap-1",
      kind: "cancelRun",
      teamId: "team-alpha",
      runId: "r-1",
      title: "Cancel stalled run r-1",
      requestedBy: "manager",
    },
  ],
  runs: [
    { id: "r-1", sessionId: "s-1", taskId: "task-2", status: "running", startedAt: "2026-10-17T12:00:00Z" },
  ],
  sessions: [],
  live: [],
  notices: [],
  notes: [],
  artifacts: [{ id: "art-1", taskId: "task-1", name: "org-spec.md", file: "E:/teams/alpha/ui/org-spec.md", size: 1024 }],
};

describe("Native Multi-Agent Views", () => {
  it("renders TeamView Organization hierarchy and switches to Tasks Kanban board + TaskReportDrawer", async () => {
    const summary = buildTeamSummary(mockSnapshot, "team-alpha");
    const tasks = groupTeamTasks(mockSnapshot, "team-alpha");
    const onTabChange = vi.fn();
    const onSelectTask = vi.fn();
    const onReviewTask = vi.fn();
    const onReadArtifact = vi.fn(async () => ({
      name: "org-spec.md",
      path: "E:/teams/alpha/ui/org-spec.md",
      content: "# Org Spec\nClean hierarchy.",
    }));

    const { rerender } = render(
      <TeamView
        teamSummary={summary}
        teamTasks={tasks}
        activeTab="organization"
        onTabChange={onTabChange}
        onSelectTask={onSelectTask}
        onReviewTask={onReviewTask}
        onReadArtifact={onReadArtifact}
      />,
    );

    // Organization tree renders leader and direct report
    expect(screen.getByText("alpha-lead")).not.toBeNull();
    expect(screen.getByText("ui-specialist")).not.toBeNull();
    expect(screen.getByText("Reports to alpha-lead")).not.toBeNull();

    // Switch to Tasks tab
    fireEvent.click(screen.getByRole("tab", { name: /Tasks/i }));
    expect(onTabChange).toHaveBeenCalledWith("tasks");

    rerender(
      <TeamView
        teamSummary={summary}
        teamTasks={tasks}
        activeTab="tasks"
        selectedTaskId="task-1"
        onTabChange={onTabChange}
        onSelectTask={onSelectTask}
        onReviewTask={onReviewTask}
        onReadArtifact={onReadArtifact}
      />,
    );

    // Action-first grouped task sections + TaskReportDrawer are both visible
    expect(screen.getByRole("region", { name: "Grouped team tasks" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Task delivery report" })).not.toBeNull();
    expect(screen.getAllByText("Implemented recursive OrgMemberNode with connector rails.").length).toBeGreaterThan(0);

    // Preview artifact inline
    fireEvent.click(screen.getByText("org-spec.md"));
    await waitFor(() => expect(screen.getByText(/# Org Spec/)).not.toBeNull());

    // Accept delivery
    fireEvent.click(screen.getByRole("button", { name: /Accept delivery/i }));
    expect(onReviewTask).toHaveBeenCalledWith("task-1", "accept");
  });

  it("renders InboxView and handles approvals, blockers, and delivery reviews", async () => {
    const items = buildInboxItems(mockSnapshot);
    const onResolveApproval = vi.fn();
    const onAnswerBlocker = vi.fn();
    const onReviewTask = vi.fn();

    render(
      <InboxView
        items={items}
        onResolveApproval={onResolveApproval}
        onAnswerBlocker={onAnswerBlocker}
        onReviewTask={onReviewTask}
      />,
    );

    expect(screen.getByText("Cancel stalled run r-1")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onResolveApproval).toHaveBeenCalledWith("ap-1", true);

    const answerInput = screen.getByLabelText(/Answer blocker for/i);
    fireEvent.change(answerInput, { target: { value: "Use warm amber." } });
    fireEvent.submit(answerInput.closest("form"));
    await waitFor(() => expect(onAnswerBlocker).toHaveBeenCalledWith("task-2", "Use warm amber."));
  });

  it("renders BackgroundView with active runs and omits log viewer buttons", async () => {
    const onCancelRun = vi.fn();

    render(
      <BackgroundView
        snapshot={mockSnapshot}
        connection="connected"
        service={{ pid: 4321, working: 1, runtime: { pid: 8765 } }}
        onCancelRun={onCancelRun}
      />,
    );

    expect(screen.getByText(/4321/)).not.toBeNull();
    expect(screen.getByText("Confirm dark mode contrast")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Service Log/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Runtime Log/i })).toBeNull();
  });

  it("integrates two-mode Multi-Agent navigation into Sidebar and keeps Inspector strictly session-scoped", () => {
    const onOpenInbox = vi.fn();
    const onOpenManager = vi.fn();
    const onOpenTeam = vi.fn();
    const onToggleMaximize = vi.fn();

    render(
      <Sidebar
        sessions={[{ id: "s-1", title: "Session 1" }]}
        activeId="s-1"
        project={{ workspace: "E:/teams/alpha", workspaces: [] }}
        agents={{
          snapshot: mockSnapshot,
          surface: { kind: "chat" },
          activeSessionContext: { kind: "member", teamId: "team-alpha", agentId: "a-1" },
          inboxCount: 3,
          bgCount: 1,
          onOpenInbox,
          onOpenManager,
          onOpenBackground: () => {},
          onOpenTeam,
          onOpenMemberChat: () => {},
        }}
      />,
    );

    expect(screen.getByText("Alpha Squad")).not.toBeNull();
    expect(screen.getByText("alpha-lead")).not.toBeNull();
    fireEvent.click(screen.getByText("Inbox"));
    expect(onOpenInbox).toHaveBeenCalledTimes(1);

    // Switch to Workspaces mode so Independent Workspaces & Recent sessions get full height
    fireEvent.click(screen.getByRole("tab", { name: /Workspaces/i }));
    expect(screen.getByText("Session 1")).not.toBeNull();

    render(
      <Inspector
        tab="context"
        maximized={false}
        onToggleMaximize={onToggleMaximize}
        info={{ session_id: "s-1" }}
      />,
    );

    expect(screen.queryByRole("tab", { name: "Team" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Expand inspector width" }));
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });
});
