import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentNotificationPermission,
  finalAssistantText,
  notificationSupported,
  showNotification,
  truncateFirstLine,
} from "./notifications.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete window.Notification;
});

function installFakeNotification(permission) {
  const created = [];
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.body = options?.body || "";
      this.onclick = null;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  FakeNotification.permission = permission;
  FakeNotification.created = created;
  window.Notification = FakeNotification;
  return FakeNotification;
}

function setHidden(hidden) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("notification gating (web-ui.md §5: only hidden tab + granted permission)", () => {
  beforeEach(() => {
    setHidden(true);
  });
  afterEach(() => {
    setHidden(false);
  });

  it("shows nothing when the page is visible, even with permission granted", () => {
    const Fake = installFakeNotification("granted");
    setHidden(false);
    expect(showNotification({ title: "Rind", body: "done" })).toBe(false);
    expect(Fake.created).toHaveLength(0);
  });

  it("shows nothing without granted permission", () => {
    const Fake = installFakeNotification("default");
    expect(showNotification({ title: "Rind", body: "done" })).toBe(false);
    expect(Fake.created).toHaveLength(0);
  });

  it("shows a notification when hidden + granted, and focusing the click closes it", () => {
    const Fake = installFakeNotification("granted");
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    expect(showNotification({ title: "Rind 回复完成", body: "first line" })).toBe(true);
    expect(Fake.created).toHaveLength(1);
    expect(Fake.created[0].title).toBe("Rind 回复完成");

    Fake.created[0].onclick();
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(Fake.created[0].closed).toBe(true);
  });

  it("reports unsupported when Notification is missing (jsdom default)", () => {
    expect(notificationSupported()).toBe(false);
    expect(currentNotificationPermission()).toBe("unsupported");
    expect(showNotification({ title: "x" })).toBe(false);
  });
});

describe("notification body = reply first line truncated to 80 chars", () => {
  it("takes the first non-empty line only", () => {
    expect(truncateFirstLine("first\nsecond\nthird")).toBe("first");
    expect(truncateFirstLine("\n\n  lead\nrest")).toBe("lead");
  });

  it("truncates at 80 characters with an ellipsis", () => {
    const long = "x".repeat(120);
    const result = truncateFirstLine(long);
    expect(result).toHaveLength(81);
    expect(result.endsWith("…")).toBe(true);
  });

  it("keeps short lines intact", () => {
    expect(truncateFirstLine("done ✓")).toBe("done ✓");
    expect(truncateFirstLine("")).toBe("");
  });
});

describe("finalAssistantText — turn_completed notification body source", () => {
  it("prefers the still-streaming text before finalization", () => {
    expect(finalAssistantText({ streaming: { turnId: "t", text: "stream text" }, entries: [] })).toBe("stream text");
  });

  it("falls back to the last assistant entry", () => {
    expect(finalAssistantText({
      streaming: null,
      entries: [
        { role: "user", content: "q" },
        { role: "assistant", content: "answer" },
      ],
    })).toBe("answer");
  });

  it("returns empty without assistant content", () => {
    expect(finalAssistantText({ entries: [{ role: "tool" }] })).toBe("");
    expect(finalAssistantText(null)).toBe("");
  });
});
