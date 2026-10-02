import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.jsx";

afterEach(cleanup);

const sessions = [
  { id: "a", title: "Alpha work" },
  { id: "b", title: "Beta fixes" },
  { id: "c", title: "Gamma notes" },
];

function renderSidebar(props = {}) {
  const handlers = {
    onNew: vi.fn(),
    onSelect: vi.fn(),
    onFork: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(async () => {}),
    onLoadMore: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  render(
    <Sidebar
      sessions={sessions}
      activeId="a"
      unreadIds={new Set(["b"])}
      runningIds={new Set(["c"])}
      hasMore
      project={{ workspace: "E:/projects/rind", workspaces: [] }}
      canFork
      canExport
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const row = (id) => document.querySelector(`.session-item[data-session-id="${id}"]`);

describe("Sidebar", () => {
  it("places projects above recent sessions and sorts interactions without date groups", () => {
    renderSidebar({ sessions: [
      { id: "old", title: "Old", updated_at: "2026-01-01" },
      { id: "new", title: "New", updated_at: "2026-09-30" },
      { id: "visited", title: "Visited", updated_at: "2026-01-01", last_interacted_at: "2026-10-01" },
    ] });
    expect([...document.querySelectorAll("[data-session-id]")].map((node) => node.dataset.sessionId)).toEqual(["visited", "new", "old"]);
    expect(document.querySelectorAll(".session-group-label")).toHaveLength(0);
    expect(document.querySelector(".sidebar-head").compareDocumentPosition(document.querySelector(".session-list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Folder on Rind computer")).not.toBeNull();
  });
  it("marks the current, unread and running sessions", () => {
    renderSidebar();
    expect(row("a").className).toContain("selected");
    expect(row("a").querySelector(".session-main").getAttribute("aria-current")).toBe("page");
    expect(row("b").querySelector(".session-unread")).not.toBeNull();
    expect(row("a").querySelector(".session-unread")).toBeNull();
    expect(row("c").querySelector(".session-running").getAttribute("aria-label")).toBe("Running");
  });

  it("selects a session and starts a new one", () => {
    const handlers = renderSidebar();
    fireEvent.click(row("b").querySelector(".session-main"));
    expect(handlers.onSelect).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByText("New session"));
    expect(handlers.onNew).toHaveBeenCalledTimes(1);
  });

  it("disables New session without a project", () => {
    renderSidebar({ project: { workspace: "" } });
    expect(screen.getByText("New session").closest("button").disabled).toBe(true);
  });

  it("filters by search, clears with Escape and hides Load more while searching", () => {
    const handlers = renderSidebar();
    fireEvent.click(screen.getByText("Load more"));
    expect(handlers.onLoadMore).toHaveBeenCalledTimes(1);
    const search = screen.getByLabelText("Search sessions");
    fireEvent.change(search, { target: { value: "beta" } });
    expect(row("a")).toBeNull();
    expect(row("b")).not.toBeNull();
    expect(screen.queryByText("Load more")).toBeNull();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No matching sessions")).not.toBeNull();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(row("a")).not.toBeNull();
  });

  it("shows the empty state without sessions", () => {
    renderSidebar({ sessions: [], hasMore: false });
    expect(screen.getByText("No sessions yet")).not.toBeNull();
  });

  it("forks and exports from the row menu", () => {
    const handlers = renderSidebar();
    fireEvent.click(row("b").querySelector(".session-more"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork" }));
    expect(handlers.onFork).toHaveBeenCalledWith("b");
    fireEvent.click(row("b").querySelector(".session-more"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export replay" }));
    expect(handlers.onExport).toHaveBeenCalledWith("b");
  });

  it("names the row menu button and confirms delete", async () => {
    const handlers = renderSidebar();
    const more = row("b").querySelector(".session-more");
    expect(more.getAttribute("aria-label")).toBe("More actions for Beta fixes");
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("Delete session?")).not.toBeNull();
    fireEvent.click(document.querySelector(".confirm-yes"));
    await waitFor(() => expect(handlers.onDelete).toHaveBeenCalledWith("b"));
  });

  it("does not allow deleting the current session", () => {
    renderSidebar();
    fireEvent.click(row("a").querySelector(".session-more"));
    const item = screen.getByRole("menuitem", { name: "Delete (switch away first)" });
    expect(item.disabled || item.getAttribute("aria-disabled") === "true").toBe(true);
  });

  it("opens settings from the footer", () => {
    const handlers = renderSidebar();
    fireEvent.click(screen.getByLabelText("Open settings"));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
