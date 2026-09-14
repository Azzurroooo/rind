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
  it("trash click asks Delete? inline; Yes deletes, No cancels", async () => {
    const onDelete = vi.fn(async () => {});
    renderRail({ onDelete });
    const item = () => document.querySelector(".session-item[data-session-id='s-1']");

    fireEvent.click(item().querySelector(".session-delete"));
    expect(screen.getByText("Delete?")).not.toBeNull();
    expect(document.querySelector(".modal-backdrop")).toBeNull();

    fireEvent.click(item().querySelector(".confirm-no"));
    expect(screen.queryByText("Delete?")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(item().querySelector(".session-delete"));
    fireEvent.click(item().querySelector(".confirm-yes"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("s-1"));
    expect(screen.queryByText("Delete?")).toBeNull();
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
    expect(del.title).toBe("Current session cannot be deleted");
  });
});

describe("SessionRail — notification permission lives in the footer", () => {
  it("shows the enable button only while permission is default", () => {
    const onEnable = vi.fn();
    const { rerender } = render(<SessionRail sessions={[]} activeId="" notificationPermission="default" onEnableNotifications={onEnable} />);
    expect(screen.getByText("Enable desktop notifications")).not.toBeNull();

    fireEvent.click(screen.getByText("Enable desktop notifications"));
    expect(onEnable).toHaveBeenCalledTimes(1);

    rerender(<SessionRail sessions={[]} activeId="" notificationPermission="granted" onEnableNotifications={onEnable} />);
    expect(screen.queryByText("Enable desktop notifications")).toBeNull();
  });
});

describe("SessionRail — search filter (audit #9)", () => {
  it("filters sessions by title client-side and clears with the × button", () => {
    renderRail();
    const input = screen.getByLabelText("Search sessions");
    fireEvent.change(input, { target: { value: "gateway" } });
    expect(screen.getByText("Fix gateway")).not.toBeNull();
    expect(screen.queryByText("Refactor auth")).toBeNull();
    expect(screen.queryByText("No matching sessions")).toBeNull();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No matching sessions")).not.toBeNull();
    fireEvent.click(screen.getByTitle("Clear search"));
    expect(screen.getByText("Refactor auth")).not.toBeNull();
  });
});

describe("SessionRail — Load more pagination (audit #9)", () => {
  it("renders the button only when hasMore is set and calls onLoadMore", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<SessionRail {...{ sessions, activeId: "s-current" }} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByText("Load more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<SessionRail sessions={sessions} activeId="s-current" hasMore={false} onLoadMore={onLoadMore} />);
    expect(screen.queryByText("Load more")).toBeNull();
  });
});
