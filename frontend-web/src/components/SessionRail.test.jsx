import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRail } from "./SessionRail.jsx";

afterEach(cleanup);

const sessions = [
  { id: "s-current", title: "Current session" },
  { id: "s-1", title: "Refactor auth" },
  { id: "s-2", title: "Fix gateway" },
];

function renderRail(overrides = {}) {
  const props = {
    sessions,
    activeId: "s-current",
    loading: false,
    workspace: "E:/projects/rind",
    workspaceDraft: "E:/projects/rind",
    workspaceBusy: false,
    workspaceMessage: "",
    unreadIds: new Set(),
    notificationPermission: "granted",
    onWorkspaceDraftChange: () => {},
    onWorkspaceApply: () => {},
    onNew: () => {},
    onSelect: vi.fn(),
    onDelete: vi.fn(async () => {}),
    ...overrides,
  };
  render(<SessionRail {...props} />);
  return props;
}

describe("SessionRail — unread dots (J7)", () => {
  it("shows a 6px dot on non-current sessions that received durable events", () => {
    renderRail({ unreadIds: new Set(["s-1"]) });
    const dot = document.querySelector(".session-item[data-session-id='s-1'] .session-unread");
    expect(dot).not.toBeNull();
    expect(document.querySelector(".session-item[data-session-id='s-current'] .session-unread")).toBeNull();
  });

  it("clears the dot once the session becomes current", () => {
    const { rerender } = render(<SessionRail
      sessions={sessions}
      activeId="s-current"
      unreadIds={new Set(["s-1"])}
      onDelete={vi.fn()}
    />);
    expect(document.querySelector("[data-session-id='s-1'] .session-unread")).not.toBeNull();

    rerender(<SessionRail
      sessions={sessions}
      activeId="s-1"
      unreadIds={new Set(["s-1"])}
      onDelete={vi.fn()}
    />);
    expect(document.querySelector("[data-session-id='s-1'] .session-unread")).toBeNull();
  });
});

describe("SessionRail — inline delete with one-click confirm (J7, no modal)", () => {
  it("trash click asks 删除？inline; 是 deletes, 否 cancels", async () => {
    const onDelete = vi.fn(async () => {});
    renderRail({ onDelete });
    const item = () => document.querySelector(".session-item[data-session-id='s-1']");

    fireEvent.click(item().querySelector(".session-delete"));
    expect(screen.getByText("删除？")).not.toBeNull();
    expect(document.querySelector(".modal-backdrop")).toBeNull();

    fireEvent.click(item().querySelector(".confirm-no"));
    expect(screen.queryByText("删除？")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(item().querySelector(".session-delete"));
    fireEvent.click(item().querySelector(".confirm-yes"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("s-1"));
    expect(screen.queryByText("删除？")).toBeNull();
  });

  it("delete errors render inline next to the item", async () => {
    const onDelete = vi.fn(async () => { throw new Error("session has an active turn"); });
    renderRail({ onDelete });
    const item = () => document.querySelector(".session-item[data-session-id='s-2']");
    fireEvent.click(item().querySelector(".session-delete"));
    fireEvent.click(item().querySelector(".confirm-yes"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("session has an active turn"));
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });

  it("the current session's delete affordance is disabled with a tooltip", () => {
    renderRail();
    const del = document.querySelector(".session-item[data-session-id='s-current'] .session-delete");
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("当前会话不可删除");
  });
});

describe("SessionRail — notification permission lives in the footer", () => {
  it("shows the enable button only while permission is default", () => {
    const onEnable = vi.fn();
    const { rerender } = render(<SessionRail sessions={[]} activeId="" notificationPermission="default" onEnableNotifications={onEnable} />);
    expect(screen.getByText("开启桌面通知")).not.toBeNull();

    fireEvent.click(screen.getByText("开启桌面通知"));
    expect(onEnable).toHaveBeenCalledTimes(1);

    rerender(<SessionRail sessions={[]} activeId="" notificationPermission="granted" onEnableNotifications={onEnable} />);
    expect(screen.queryByText("开启桌面通知")).toBeNull();
  });
});

describe("SessionRail — search filter (audit #9)", () => {
  it("filters sessions by title client-side and clears with the × button", () => {
    renderRail();
    const input = screen.getByLabelText("搜索会话");
    fireEvent.change(input, { target: { value: "gateway" } });
    expect(screen.getByText("Fix gateway")).not.toBeNull();
    expect(screen.queryByText("Refactor auth")).toBeNull();
    expect(screen.queryByText("没有匹配的会话")).toBeNull();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("没有匹配的会话")).not.toBeNull();
    fireEvent.click(screen.getByTitle("清除搜索"));
    expect(screen.getByText("Refactor auth")).not.toBeNull();
  });
});

describe("SessionRail — 加载更多 pagination (audit #9)", () => {
  it("renders the button only when hasMore is set and calls onLoadMore", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<SessionRail {...{ sessions, activeId: "s-current" }} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByText("加载更多"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<SessionRail sessions={sessions} activeId="s-current" hasMore={false} onLoadMore={onLoadMore} />);
    expect(screen.queryByText("加载更多")).toBeNull();
  });
});
