import { DEMO_CONTEXT_WINDOW_TOKENS, demoInfo, PROVIDERS } from "./demo.js";
import { closeMenu, info, menu, note, shell, slashResult, startup, submit, type } from "./steps.js";

export const loginPages = [
  {
    id: "login.provider",
    feature: "/login",
    title: "Configure a provider",
    steps: [
      note([
        "Before your first task, use /login to configure a provider.",
        "Choose account sign-in, an API key, or add a named OpenAI-compatible endpoint through the API-key flow.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_101530_ab12cd34" })),
      type("/login"),
      submit(),
      menu({
        kind: "auth-choice",
        title: "Sign in",
        options: ["Sign in with an account", "Sign in with an API key"],
        selected: 0,
        target: 1,
      }, [
        "/login first asks how: with an account, such as ChatGPT, or with an API key.",
      ]),
      menu({
        kind: "auth-choice",
        title: "Provider",
        options: PROVIDERS,
        selected: 0,
        target: 0,
      }, [
        "Then it lists the providers that sign in that way.",
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
            { label: "connection", value: "zai · Z.AI" },
            { label: "endpoint", value: "https://api.z.ai/api/paas/v4" },
            { label: "key", value: "stored login" },
            { label: "model", value: "glm-4.7" },
            { label: "reasoningEffort", value: "high" },
          ],
          usage: [{
            context_window_tokens: DEMO_CONTEXT_WINDOW_TOKENS,
            context_usage_percent: 48200 / DEMO_CONTEXT_WINDOW_TOKENS,
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
  {
    id: "login.account", feature: "ChatGPT sign-in", title: "Use your subscription",
    steps: [
      note(["Connect an eligible ChatGPT subscription using OpenAI account sign-in, without an API key.", "This simulation opens no browser and stores no credentials. Sign in after leaving the tour."]),
      shell("rind"), startup(demoInfo({ session: "demo-account" })),
      type("/login openai"), submit(),
      menu({ kind: "auth-choice", title: "Sign in", options: ["Sign in with an account", "Sign in with an API key"], selected: 0 },
        "Select Sign in with an account. This is OpenAI's account authorization flow, not a third-party API key."),
      closeMenu("Enter"),
      slashResult({ text: "OpenAI account authorization · browser step (simulated)" }),
      note(["In real login, authorize in the browser. The local callback finishes login automatically.", "If the callback fails, use the offered final-redirect-URL fallback. Never paste account tokens into chat."]),
      slashResult({ text: "Logged in to openai. Switched to openai / gpt-5.4." }),
      info({ model: "openai/gpt-5.4" }),
      note(["/model lists your account's models. Eligibility and limits depend on your plan, not unlimited API access.", "Login is stored in RIND_HOME/auth.json; /logout openai removes it locally."]),
    ],
  },
  {
    id: "login.endpoint", feature: "Named endpoint", title: "Connect your own URL",
    steps: [
      note(["Keep several OpenAI-compatible endpoints under different names, each with its own URL and key.", "Use /login instead of placing secrets in project settings. All values here are fictional."]),
      shell("rind"), startup(demoInfo({ session: "demo-endpoint" })),
      type("/login"), submit(),
      menu({ kind: "auth-choice", title: "Sign in", options: ["Sign in with an account", "Sign in with an API key"], selected: 0, target: 1 }),
      menu({ kind: "auth-choice", title: "Provider", options: PROVIDERS, selected: 0, target: 2 },
        "Select + Add a named endpoint. A name keeps this connection separate from the built-in providers."),
      menu({ kind: "auth-input", title: "Connection name", value: "Demo endpoint" }),
      menu({ kind: "auth-input", title: "Base URL (OpenAI-compatible, e.g. https://host/v1)", value: "https://api.example.invalid/v1" }),
      menu({ kind: "auth-input", title: "Model id (empty: use the endpoint model list)", value: "demo-model" },
        "A model id is optional: leave it empty to use the endpoint's model list. Match the URL and model to your actual service."),
      menu({ kind: "auth-secret", title: "Demo endpoint API key", value: "demo-key-only" }, "The key is masked and saved in auth.json, never in project files by this flow."),
      closeMenu("Enter"),
      slashResult({ text: "Logged in to demo-endpoint. Switched to demo-endpoint / demo-model." }),
      info({ model: "demo-endpoint/demo-model" }),
      note(["/model groups models by connection name. /status shows the active connection, endpoint and credential source, not the secret.", "/logout demo-endpoint removes this named connection and its stored key."]),
    ],
  },
];
