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

  it("opens on General with Global Default Configuration locked by default, groups Default provider by OAuth/Custom/Built-in in minimalist custom dropdowns, keeps Default model clean, unlocks on Edit, and saves on Save changes", async () => {
    const handlers = renderSettings();
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").getAttribute("data-value")).toBe("deepseek");
    });

    // Explicitly labeled as Global Default Configuration
    expect(document.querySelector(".settings-dialog").textContent).toContain("Global Default Configuration");
    expect(document.querySelector(".settings-dialog").textContent).toContain("~/.rind/settings.json");

    const providerTrigger = screen.getByLabelText("Default provider");
    const modelTrigger = screen.getByLabelText("Default model");
    const effortTrigger = screen.getByLabelText("Reasoning effort");
    const saveBtn = screen.getByRole("button", { name: "Save changes" });

    // Trigger displays provider name + subtle source badge
    expect(providerTrigger.textContent).toContain("DeepSeek");
    expect(providerTrigger.textContent).toContain("Built-in");
    expect(modelTrigger.textContent).toBe("deepseek-flash");

    // All fields and Save changes are disabled by default (foolproof lock)
    expect(providerTrigger.disabled).toBe(true);
    expect(modelTrigger.disabled).toBe(true);
    expect(effortTrigger.disabled).toBe(true);
    expect(saveBtn.disabled).toBe(true);

    // Workspace Override is not shown in General
    expect(document.querySelector(".settings-dialog").textContent).not.toContain("Workspace Override");

    // Verify both header Close button and footer Close button are outside the scrolling .settings-content
    const headerCloseBtn = screen.getByRole("button", { name: "Close dialog" });
    const footerCloseBtn = screen.getByRole("button", { name: "Close" });
    const scrollingContent = document.querySelector(".settings-content");
    expect(scrollingContent.classList.contains("panel-scroll")).toBe(true);
    expect(scrollingContent.contains(headerCloseBtn)).toBe(false);
    expect(scrollingContent.contains(footerCloseBtn)).toBe(false);

    // Clicking Edit unlocks the fields and enables Save changes
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(providerTrigger.disabled).toBe(false);
    expect(modelTrigger.disabled).toBe(false);
    expect(effortTrigger.disabled).toBe(false);
    expect(saveBtn.disabled).toBe(false);

    // Opening Default provider dropdown shows custom grouped sections (OAuth & Accounts, Custom APIs, Built-in Providers)
    fireEvent.click(providerTrigger);
    const providerMenu = screen.getByRole("listbox", { name: "Default provider options" });
    const groups = [...providerMenu.querySelectorAll(".settings-select-group")].map((g) => ({
      label: g.querySelector(".settings-select-group-title")?.textContent,
      options: [...g.querySelectorAll('[role="option"]')].map((o) => ({
        value: o.getAttribute("data-value"),
        label: o.querySelector(".settings-select-option-label")?.textContent,
        badge: o.querySelector(".settings-select-badge")?.textContent,
      })),
    }));
    expect(groups).toEqual([
      {
        label: "OAuth & Accounts",
        options: [{ value: "openai", label: "OpenAI", badge: "OAuth" }],
      },
      {
        label: "Custom APIs",
        options: [{ value: "xiaomi", label: "Xiaomi", badge: "Custom" }],
      },
      {
        label: "Built-in Providers",
        options: [{ value: "deepseek", label: "DeepSeek", badge: "Built-in" }],
      },
    ]);

    // Selecting OpenAI from the custom dropdown closes the menu and updates Default model cleanly
    fireEvent.click(providerMenu.querySelector('[data-value="openai"]'));
    expect(screen.getByLabelText("Default provider").getAttribute("data-value")).toBe("openai");

    // Open Default model custom dropdown and verify clean model IDs without Built-in / OAuth / Custom suffixes
    fireEvent.click(screen.getByLabelText("Default model"));
    const modelMenu = screen.getByRole("listbox", { name: "Default model options" });
    const modelOptionTexts = [...modelMenu.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(modelOptionTexts).toContain("gpt-5");
    expect(modelOptionTexts.some((t) => t.includes("Built-in") || t.includes("OAuth") || t.includes("Custom"))).toBe(
      false,
    );

    // Selecting a non-reasoning model hides Reasoning effort
    fireEvent.click(modelMenu.querySelector('[data-value="gpt-4o-mini"]'));
    expect(screen.queryByLabelText("Reasoning effort")).toBeNull();

    // Selecting a reasoning model reveals Reasoning effort
    fireEvent.click(screen.getByLabelText("Default model"));
    fireEvent.click(
      screen.getByRole("listbox", { name: "Default model options" }).querySelector('[data-value="gpt-5"]'),
    );
    fireEvent.click(screen.getByLabelText("Reasoning effort"));
    fireEvent.click(
      screen.getByRole("listbox", { name: "Reasoning effort options" }).querySelector('[data-value="xhigh"]'),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(handlers.request).toHaveBeenCalledWith("rind/folder_defaults/set", {
        scope: "global",
        provider_id: "openai",
        model_id: "gpt-5",
        reasoning_effort: "xhigh",
      });
    });

    // After saving, fields return to locked (disabled) state
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").disabled).toBe(true);
    });
  });

  it("separates OAuth & Accounts, Custom APIs, and Built-in Providers in Providers tab with Manage/Connect buttons without ▾", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").getAttribute("data-value")).toBe("deepseek");
    });
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(screen.getByRole("button", { name: "Providers" }).getAttribute("aria-current")).toBe("page");

    await waitFor(() => {
      expect(document.querySelector(".settings-dialog").textContent).toContain("Subscription · OAuth");
    });
    const dialogText = document.querySelector(".settings-dialog").textContent;
    expect(dialogText).toContain("OAuth & Accounts");
    expect(dialogText).toContain("Custom APIs");
    expect(dialogText).toContain("Built-in Providers");
    expect(dialogText).toContain("sk-••••9999");
    expect(dialogText).toContain("https://api.xiaomimimo.com/v1");
    expect(dialogText).not.toContain("▾");

    // Every provider row has a single top-level button in .provider-actions ("Manage" or "Connect", never "▾")
    const rows = document.querySelectorAll(".provider-row");
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const buttons = row.querySelectorAll(".provider-actions > button, .provider-actions > .provider-menu-wrap > button");
      expect(buttons).toHaveLength(1);
      expect(["Manage", "Connect"]).toContain(buttons[0].textContent.trim());
    }

    // Both header Close button and footer Close button remain present and outside .settings-content on Providers tab
    const headerCloseBtn = screen.getByRole("button", { name: "Close dialog" });
    const footerCloseBtn = screen.getByRole("button", { name: "Close" });
    const scrollingContent = document.querySelector(".settings-content");
    expect(scrollingContent.contains(headerCloseBtn)).toBe(false);
    expect(scrollingContent.contains(footerCloseBtn)).toBe(false);
  });

  it("navigates to Preferences and Account to switch theme, view keyboard shortcuts, and sign out", async () => {
    const handlers = renderSettings();
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").getAttribute("data-value")).toBe("deepseek");
    });
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
