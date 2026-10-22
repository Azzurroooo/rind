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
      type("/login", [
        "Run /login to connect a built-in provider or a custom endpoint.",
      ]),
      submit(),
      menu({
        kind: "choice-dialog",
        title: "Login · Sign in",
        options: ["Sign in with an account", "Sign in with an API key"],
        selected: 0,
        target: 1,
      }, [
        "/login first asks how: with an account, such as ChatGPT, or with an API key.",
      ]),
      menu({
        kind: "choice-dialog",
        title: "Login · Provider",
        options: PROVIDERS,
        selected: 0,
        target: 0,
      }, [
        "Then it lists the providers that sign in that way. Configured entries show their source;",
        "the demo selects Z.ai and opens its API key prompt.",
      ]),
      menu({
        kind: "auth-secret",
        title: "Z.ai",
        message: "API key",
        value: "demo-key-only",
      }, [
        "Secrets are masked as you type (Esc cancels). This is a masked example,",
        "not a field you can type into — exit the tour before running /login for real.",
      ]),
      note([
        "Secrets are masked as you type (Esc cancels). This is a masked example,",
        "not a field you can type into — exit the tour before running /login for real.",
      ]),
      closeMenu("Enter"),
      info({ model: "GPT-6-Astra", reasoning_effort: "xhigh" }),
      slashResult({ text: "Logged in to zai. Switched to zai / GPT-6-Astra." }, [
        "Login saves the credential to ~/.rind/auth.json and switches to the provider's model.",
      ]),
      type("/status", [
        "Run /status to inspect your active model, provider connection, sign-in method and context usage.",
      ]),
      submit(),
      slashResult({
        text: "Status",
        display: {
          type: "status",
          selection: {
            provider: "Z.ai",
            model: "GPT-6-Astra",
            reasoning_effort: "xhigh",
          },
          entries: [
            { group: "model", label: "model", value: "GPT-6-Astra", note: "session", note_tone: "accent" },
            { group: "model", label: "effort", value: "xhigh", note: "session", note_tone: "accent" },
            { group: "provider", label: "provider", value: "Z.ai · zai", note: "built-in · openai-chat" },
            { group: "provider", label: "sign-in", value: "API key", note: "saved login (auth.json)" },
            { group: "provider", label: "endpoint", value: "https://api.z.ai/api/paas/v4" },
            { group: "conversation", label: "session", value: "20260917_101530_ab12cd34" },
            { group: "settings", label: "settings", value: "~/.rind/settings.json" },
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
        "/logout removes stored credentials; settings.json credentials may still apply.",
      ]),
    ],
  },
  {
    id: "login.account", feature: "ChatGPT sign-in", title: "Use your subscription",
    steps: [
      note(["Connect an eligible ChatGPT subscription using OpenAI account sign-in, without an API key.", "This simulation opens no browser and stores no credentials. Sign in after leaving the tour."]),
      shell("rind"), startup(demoInfo({ session: "demo-account" })),
      type("/login openai", [
        "Pass the provider id directly (/login openai) to jump straight to its sign-in options.",
      ]),
      submit(),
      menu({ kind: "choice-dialog", title: "Login · Sign in", options: ["Sign in with an account", "Sign in with an API key"], selected: 0 },
        "Select Sign in with an account. This is OpenAI's account authorization flow, not a third-party API key."),
      closeMenu("Enter"),
      slashResult({ text: "OpenAI account authorization · browser step (simulated)" }),
      note(["In real login, authorize in the browser. The local callback finishes login automatically.", "If the callback fails, use the offered final-redirect-URL fallback. Never paste account tokens into chat."]),
      slashResult({ text: "Logged in to openai. Switched to openai / GPT-6-Astra." }),
      info({ model: "GPT-6-Astra", reasoning_effort: "xhigh" }),
      note(["/model lists your account's models. Eligibility and limits depend on your plan, not unlimited API access.", "Login is stored in RIND_HOME/auth.json; /logout openai removes it locally."]),
    ],
  },
  {
    id: "login.endpoint", feature: "Named endpoint", title: "Connect your own URL",
    steps: [
      note(["Keep several custom providers under different names, each with its own protocol, URL and key.", "Use /login instead of placing secrets in project settings. All values here are fictional."]),
      shell("rind"), startup(demoInfo({ session: "demo-endpoint" })),
      type("/login", [
        "Run /login to add a named OpenAI-, Anthropic- or Gemini-compatible endpoint.",
      ]),
      submit(),
      menu({ kind: "choice-dialog", title: "Login · Sign in", options: ["Sign in with an account", "Sign in with an API key"], selected: 0, target: 1 },
        "Custom endpoints use the API-key sign-in flow."),
      menu({ kind: "choice-dialog", title: "Login · Provider", options: PROVIDERS, selected: 0, target: 2 },
        "Select + Add a custom provider. A name keeps this connection separate from the built-in providers."),
      menu({ kind: "auth-input", title: "Connection name", value: "Demo endpoint" },
        "Give the connection a short name; Rind slugifies it as the provider id (demo-endpoint)."),
      menu({ kind: "choice-dialog", title: "Login · API protocol for Demo endpoint", options: ["openai-chat · OpenAI Chat Completions", "openai-responses · OpenAI Responses", "anthropic-messages · Anthropic Messages", "google-generative-ai · Google Gemini"], selected: 0, target: 0 },
        "Choose the wire protocol your endpoint speaks."),
      menu({ kind: "auth-input", title: "Base URL (e.g. https://host/v1)", value: "https://api.example.invalid/v1" },
        "Enter the base URL for your service or proxy."),
      menu({ kind: "auth-input", title: "Model id (empty: use the endpoint model list)", value: "GPT-6-Astra" },
        "A model id is optional: leave it empty to use the endpoint's model list. Match the URL and model to your actual service."),
      menu({ kind: "auth-secret", title: "Demo endpoint API key", value: "demo-key-only" }, "The key is masked and saved in auth.json, never in project files by this flow."),
      closeMenu("Enter"),
      slashResult({ text: "Logged in to demo-endpoint. Switched to demo-endpoint / GPT-6-Astra." }),
      info({ model: "GPT-6-Astra", reasoning_effort: "xhigh" }),
      note(["/model groups models by connection name. /status shows the active connection, endpoint and credential source, not the secret.", "/logout demo-endpoint removes this named connection and its stored key."]),
    ],
  },
];
