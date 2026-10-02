import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog.jsx";

afterEach(cleanup);

function renderSettings(props = {}) {
  const handlers = { onClose: vi.fn(), onTheme: vi.fn(), onLogout: vi.fn() };
  render(<SettingsDialog open theme="system" {...handlers} {...props} />);
  return handlers;
}

describe("SettingsDialog", () => {
  it("renders nothing when closed", () => {
    render(<SettingsDialog open={false} />);
    expect(document.querySelector(".settings-dialog")).toBeNull();
  });

  it("opens on Appearance and switches the theme through a radiogroup", () => {
    const handlers = renderSettings();
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(handlers.onTheme).toHaveBeenCalledWith("dark");
  });

  it("navigates to Keyboard and Account", () => {
    const handlers = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
    expect(screen.getByRole("button", { name: "Keyboard" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(document.querySelector(".settings-dialog").textContent).toContain("Connection is managed automatically");
    fireEvent.click(screen.getByRole("button", { name: /Sign out of this device/ }));
    expect(handlers.onLogout).toHaveBeenCalledTimes(1);
  });
});
