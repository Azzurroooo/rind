// Shared demo fixtures for tour pages: one coherent fake project so every
// page tells the same story (workspace ~/demo, model GPT-6-Astra, effort xhigh).

export function demoInfo({ cwd = "~/demo", session, model = "GPT-6-Astra", reasoning_effort = "xhigh" }) {
  return {
    model,
    session_id: session,
    cwd,
    reasoning_effort,
  };
}

export const MODELS = [
  { header: true, name: "openai" },
  { modelId: "GPT-6-Astra", current: true, image_input: true },
  { header: true, name: "demo-endpoint" },
  { modelId: "GPT-6-Astra", image_input: true },
];

export const EFFORTS = [
  { modelId: "low" },
  { modelId: "medium" },
  { modelId: "high" },
  { modelId: "xhigh", current: true },
  { modelId: "max" },
];

export const SETTINGS_ROOT_ITEMS = [
  { label: "Brief output", value: "Off", description: "Compact tool results and assistant summaries" },
  { label: "Theme", value: "Mocha ›", description: "Terminal color palette for transcript and menus" },
  { label: "Working spinner", value: "Braille ›", description: "Activity indicator shown during live turns" },
  { label: "Import skills", value: "1 source ›", description: "Include skills from ~/.claude or ~/.codex" },
];

export const REMOTE_ITEMS_OFF = [
  {
    id: "toggle",
    label: "Remote access",
    value: "Off",
    description: "Press space or enter to turn on (Local network) and show QR code",
  },
  {
    id: "scope",
    label: "Network scope",
    value: "Local network ›",
    description: "Wi-Fi / LAN devices and this computer",
  },
];

export const REMOTE_ITEMS_ON = [
  {
    id: "toggle",
    label: "Remote access",
    value: "On · 1 connected device",
    description: "Press space or enter to turn off remote access",
  },
  {
    id: "qr",
    label: "QR code & sign-in link",
    value: "http://192.168.1.24:8766 ›",
    description: "Display pairing QR code and connection details (Esc to close)",
  },
  {
    id: "scope",
    label: "Network scope",
    value: "Local network ›",
    description: "Wi-Fi / LAN devices and this computer",
  },
  {
    id: "rotate",
    label: "Rotate access code",
    value: "rotate ›",
    description: "Generate a new code and disconnect connected devices",
  },
];

export const SESSIONS = [
  "20260917_103001_eff01a23 · parser work",
  "20260916_181122_c88be701 · current · refactor jsonl store",
  "20260915_090412_a10f5c02 · tour docs draft",
];

export const FORK_POINTS = [
  "Fork at current end (keep full history)",
  "10:32 · Now add tests for it",
  "10:31 · Summarize how the parser handles unicode",
];

export const TEST_TASK = {
  task_id: "task-demo",
  bg_id: "task-demo",
  status: "running",
  notify: "on_exit",
  elapsed_ms: 1000,
  command: "npm test",
  stdout: "▶ tour-stage.test.js (21/21)\n▶ tour-render.test.js (11/11)",
};

export const DEMO_CONTEXT_WINDOW_TOKENS = 256000;

export const BOARD_PAGES = [
  {
    index: 1,
    count: 2,
    breakdown: {
      context_window_tokens: DEMO_CONTEXT_WINDOW_TOKENS,
      estimated_total: 48200,
      turn_id: "t_9f21",
      captured_at: "2026-09-17T10:31:22Z",
      sections: [
        { key: "system_prompt", label: "System prompt", tokens: 2100, messages: 1 },
        { key: "rind_docs", label: "RIND.md", tokens: 3600, messages: 1 },
        { key: "chat_user", label: "Conversation", tokens: 4200, messages: 6 },
        { key: "chat_assistant", label: "Conversation", tokens: 18300, messages: 6 },
        { key: "tool_specs", label: "Tool specs", tokens: 8400, messages: 14 },
        { key: "tool:read_file", label: "Tool results", tokens: 11600, messages: 8 },
      ],
    },
  },
  {
    index: 2,
    count: 2,
    summary: {
      days: 5,
      totals: { samples: 41, input: 88000, cached: 58000, output: 14000, reasoning: 3000, compactions: 1 },
      by_day: [
        { day: "2026-09-13", tokens: 21000 },
        { day: "2026-09-14", tokens: 8000 },
        { day: "2026-09-16", tokens: 42000 },
        { day: "2026-09-17", tokens: 31000 },
      ],
      by_model: [{ model: "GPT-6-Astra", tokens: 102000 }],
      recent_sessions: [{ session_id: "eff01a23", updated_at: "2026-09-17T10:31:22Z", tokens: 31000 }],
    },
  },
];

export const PROVIDERS = [
  "zai · Z.ai · not configured",
  "openai · OpenAI · not configured",
  "+ Add a custom provider · API protocol, URL, and key",
];

export const SKILL_SOURCES = [
  { label: "Rind · built-in", paths: ["~/.rind/skills/.system"], enabled: true, importable: false,
    skills: [{ name: "skill-creator", description: "Create or improve a Skill", status: "active" }] },
  { label: "Claude · user", paths: ["~/.claude/skills"], enabled: true, importable: true,
    skills: [{ name: "commit-lint", description: "Check commit messages against the repo style", status: "active" }] },
  { label: "Codex · user", paths: ["~/.codex/skills", "~/.agents/skills"], enabled: false, importable: true,
    skills: [{ name: "pdf", description: "Fill PDF forms", status: "off" }] },
  { label: "Rind · project", paths: ["~/demo/.rind/skills"], enabled: true, importable: false,
    skills: [{ name: "release-notes", description: "Draft release notes from the JSONL log", status: "active" }] },
];
