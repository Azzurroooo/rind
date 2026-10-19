import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSettings(props = {}) {
  const handlers = {
    onClose: vi.fn(),
    onTheme: vi.fn(),
    onLogout: vi.fn(),
    request: vi.fn().mockImplementation(async (method) => {
      if (method === "rind/folder_defaults/get") {
        return {
          workspace_root: "/repo",
          folder: null,
          resolved: { provider_id: "deepseek", model_id: "deepseek-flash", reasoning_effort: "high" },
          inherited: true,
        };
      }
      if (method === "rind/auth/list") {
        return {
          providers: [
            { id: "openai", name: "OpenAI", configured: true, source: "auth.json", methods: ["api_key", "oauth"], env_key: "OPENAI_API_KEY" },
            { id: "deepseek", name: "DeepSeek", configured: true, source: "auth.json", methods: ["api_key"], env_key: "DEEPSEEK_API_KEY" },
            { id: "anthropic", name: "Anthropic", configured: false, source: "", methods: ["api_key"], env_key: "ANTHROPIC_API_KEY" },
          ],
        };
      }
      return {};
    }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (url === "/api/settings" && (!init || init.method !== "POST")) {
      return {
        ok: true,
        json: async () => ({
          result: {
            provider: "deepseek",
            model: "deepseek-flash",
            baseUrl: "",
            reasoningEffort: "high",
            hasApiKey: true,
            authDetails: {
              openai: { type: "oauth", expiresAt: 1999999999 },
              deepseek: { type: "api_key", maskedKey: "sk-••••9999" },
            },
            customProviders: [
              {
                id: "xiaomi",
                name: "Xiaomi",
                api: "openai-chat",
                baseUrl: "https://api.xiaomimimo.com/v1",
                models: ["mimo-v2-flash"],
              },
            ],
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        result: {
          provider: "openai",
          model: "gpt-5",
          baseUrl: "",
          reasoningEffort: "xhigh",
          hasApiKey: true,
          authDetails: {},
          customProviders: [],
        },
      }),
    };
  });
  render(<SettingsDialog open theme="system" workspace="/repo" {...handlers} {...props} />);
  return handlers;
}

describe("SettingsDialog", () => {
  it("renders nothing when closed", () => {
    render(<SettingsDialog open={false} />);
    expect(document.querySelector(".settings-dialog")).toBeNull();
  });

  it("opens on General showing only configured providers, links model & reasoning effort, and keeps Close buttons outside scrolling content", async () => {
    const handlers = renderSettings();
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").value).toBe("deepseek");
    });

    // Only configured providers (DeepSeek, OpenAI, Xiaomi) appear in Default provider; unconfigured Anthropic is hidden
    const providerSelect = screen.getByLabelText("Default provider");
    const optionValues = [...providerSelect.querySelectorAll("option")].map((o) => o.value);
    expect(optionValues).toEqual(["deepseek", "openai", "xiaomi"]);
    expect(optionValues).not.toContain("anthropic");

    // Workspace Override is not shown in General
    expect(document.querySelector(".settings-dialog").textContent).not.toContain("Workspace Override");

    expect(screen.getByLabelText("Default model").value).toBe("deepseek-flash");
    expect(screen.getByLabelText("Reasoning effort").value).toBe("high");

    // Verify both header Close button and footer Close button are outside the scrolling .settings-content
    const headerCloseBtn = screen.getByRole("button", { name: "Close dialog" });
    const footerCloseBtn = screen.getByRole("button", { name: "Close" });
    const scrollingContent = document.querySelector(".settings-content");
    expect(scrollingContent.contains(headerCloseBtn)).toBe(false);
    expect(scrollingContent.contains(footerCloseBtn)).toBe(false);

    // Selecting a non-reasoning model hides Reasoning effort
    fireEvent.change(providerSelect, { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "gpt-4o-mini" } });
    expect(screen.queryByLabelText("Reasoning effort")).toBeNull();

    // Selecting a reasoning model reveals Reasoning effort
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "gpt-5" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "xhigh" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(handlers.request).toHaveBeenCalledWith("rind/folder_defaults/set", {
        scope: "global",
        provider_id: "openai",
        model_id: "gpt-5",
        reasoning_effort: "xhigh",
      });
    });
  });

  it("separates Custom APIs and Built-in Providers in Providers tab with a single action button per row", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(screen.getByRole("button", { name: "Providers" }).getAttribute("aria-current")).toBe("page");

    await waitFor(() => {
      expect(document.querySelector(".settings-dialog").textContent).toContain("Subscription · OAuth");
    });
    const dialogText = document.querySelector(".settings-dialog").textContent;
    expect(dialogText).toContain("Custom APIs");
    expect(dialogText).toContain("Built-in Providers");
    expect(dialogText).toContain("sk-••••9999");
    expect(dialogText).toContain("https://api.xiaomimimo.com/v1");

    // Every provider row has a single top-level button in .provider-actions before any menu is opened
    const rows = document.querySelectorAll(".provider-row");
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const buttons = row.querySelectorAll(".provider-actions > button, .provider-actions > .provider-menu-wrap > button");
      expect(buttons).toHaveLength(1);
    }

    // Both header Close button and footer Close button remain present and outside .settings-content on Providers tab
    const headerCloseBtn = screen.getByRole("button", { name: "Close dialog" });
    const footerCloseBtn = screen.getByRole("button", { name: "Close" });
    const scrollingContent = document.querySelector(".settings-content");
    expect(scrollingContent.contains(headerCloseBtn)).toBe(false);
    expect(scrollingContent.contains(footerCloseBtn)).toBe(false);
  });

  it("navigates to Preferences and Account to switch theme, view keyboard shortcuts, and sign out", () => {
    const handlers = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    expect(screen.getByRole("button", { name: "Preferences" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(handlers.onTheme).toHaveBeenCalledWith("dark");

    expect(document.querySelector(".settings-dialog").textContent).toContain("Open command palette");

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector(".settings-dialog").textContent).toContain("Connection is managed automatically");
    fireEvent.click(screen.getByRole("button", { name: /Sign out of this device/ }));
    expect(handlers.onLogout).toHaveBeenCalledTimes(1);
  });
});
