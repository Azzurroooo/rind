import { demoInfo, PROVIDERS } from "./demo.js";
import { menu, note, result, shell, slashResult, startup } from "./steps.js";

export const loginPages = [
  {
    id: "login.provider",
    title: "Configure a provider",
    steps: [
      note([
        "Rind works with any OpenAI-compatible endpoint. Credentials live in",
        "~/.rind/settings.json — the only API configuration source.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_101530_ab12cd34" })),
      menu({
        kind: "auth-choice",
        title: "Provider",
        options: PROVIDERS,
        selected: 0,
        target: 1,
      }, [
        "/login lists providers discovered from settings and environment.",
        "Configured entries already show their source.",
      ]),
      menu({
        kind: "auth-secret",
        title: "Zai",
        message: "API key",
        value: "sk-9f21ab47c0",
      }, [
        "Secrets are masked as you type; esc cancels the login.",
      ]),
      result("Logged in to zai", "switched to zai / glm-4.7"),
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
        "/status confirms the whole chain: session, provider, model and live",
        "token usage for the current context window.",
      ]),
    ],
  },
];
