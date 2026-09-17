import { demoInfo, PROVIDERS } from "./demo.js";
import { closeMenu, menu, note, shell, slashResult, startup, submit, type } from "./steps.js";

export const loginPages = [
  {
    id: "login.provider",
    title: "Configure a provider",
    steps: [
      note([
        "Before your first task, use /login to configure a provider.",
        "Custom endpoint? Set model, apiKey and baseUrl in .rind/settings.json, or ~/.rind/settings.json as a fallback.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_101530_ab12cd34" })),
      type("/login"),
      submit(),
      menu({
        kind: "auth-choice",
        title: "Provider",
        options: PROVIDERS,
        selected: 0,
        target: 0,
      }, [
        "/login lists providers discovered from settings and environment.",
        "Configured entries already show their source.",
      ]),
      note(["The demo selects Z.ai. In Rind, choose your provider and press Enter; its available login flow determines the next prompts."]),
      menu({
        kind: "auth-secret",
        title: "Z.ai",
        message: "API key",
        value: "demo-key-only",
      }, [
        "Secrets are masked as you type; esc cancels the login.",
      ]),
      note(["This is a masked example, not a credential field you can type into. Exit the tour before running /login for real."]),
      closeMenu("Enter"),
      slashResult({ text: "Logged in to zai. Switched to zai / glm-4.7." }),
      type("/status"),
      submit(),
      slashResult({
        text: "Status",
        display: {
          type: "status",
          entries: [
            { label: "session", value: "20260917_101530_ab12cd34" },
            { label: "provider", value: "zai" },
            { label: "model", value: "glm-4.7" },
            { label: "reasoningEffort", value: "high" },
            { label: "configured", value: "zai" },
          ],
          usage: [{
            context_window_tokens: 200000,
            context_usage_percent: 0.24,
            input_tokens: 48200,
            cached_input_tokens: 38900,
            cache_hit_rate: 0.81,
            output_tokens: 3120,
          }],
        },
      }),
      note([
        "Try /login, then /status. Login credentials use ~/.rind/auth.json (or RIND_HOME/auth.json).",
        "/logout removes stored credentials; settings or environment credentials may still apply.",
      ]),
    ],
  },
];
