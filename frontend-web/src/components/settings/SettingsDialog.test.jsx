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

  it("opens on General with Global Default Configuration locked by default, shows Built-in/OAuth/Custom tags on models, unlocks on Edit, and saves on Save changes", async () => {
    const handlers = renderSettings();
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").value).toBe("deepseek");
    });

    // Explicitly labeled as Global Default Configuration
    expect(document.querySelector(".settings-dialog").textContent).toContain("Global Default Configuration");
    expect(document.querySelector(".settings-dialog").textContent).toContain("~/.rind/settings.json");

    const providerSelect = screen.getByLabelText("Default provider");
    const modelSelect = screen.getByLabelText("Default model");
    const effortSelect = screen.getByLabelText("Reasoning effort");
    const saveBtn = screen.getByRole("button", { name: "Save changes" });

    // All fields and Save changes are disabled by default (foolproof lock)
    expect(providerSelect.disabled).toBe(true);
    expect(modelSelect.disabled).toBe(true);
    expect(effortSelect.disabled).toBe(true);
    expect(saveBtn.disabled).toBe(true);

    // Only configured providers (DeepSeek, OpenAI, Xiaomi) appear in Default provider with their source tags
    const providerOptions = [...providerSelect.querySelectorAll("option")].map((o) => ({
      value: o.value,
      text: o.textContent,
    }));
    expect(providerOptions).toEqual([
      { value: "deepseek", text: "DeepSeek · Built-in" },
      { value: "openai", text: "OpenAI · OAuth" },
      { value: "xiaomi", text: "Xiaomi · Custom" },
    ]);

    // Default model dropdown displays the source tag (Built-in / OAuth / Custom)
    const modelOptionTexts = [...modelSelect.querySelectorAll("option")].map((o) => o.textContent);
    expect(modelOptionTexts).toContain("deepseek-flash · Built-in");

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
    expect(providerSelect.disabled).toBe(false);
    expect(modelSelect.disabled).toBe(false);
    expect(effortSelect.disabled).toBe(false);
    expect(saveBtn.disabled).toBe(false);

    // Selecting OpenAI shows OAuth tag on its models; selecting a non-reasoning model hides Reasoning effort
    fireEvent.change(providerSelect, { target: { value: "openai" } });
    const openaiModelTexts = [...screen.getByLabelText("Default model").querySelectorAll("option")].map(
      (o) => o.textContent,
    );
    expect(openaiModelTexts).toContain("gpt-5 · OAuth");
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

    // After saving, fields return to locked (disabled) state
    await waitFor(() => {
      expect(screen.getByLabelText("Default provider").disabled).toBe(true);
    });
  });

  it("separates OAuth & Accounts, Custom APIs, and Built-in Providers in Providers tab with Manage/Connect buttons without ▾", async () => {
    renderSettings();
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
