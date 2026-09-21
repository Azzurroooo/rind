// Shared demo fixtures for tour pages: one coherent fake project so every
// page tells the same story (workspace ~/demo, provider zai, model glm-4.7).

export function demoInfo({ cwd = "~/demo", session, model = "zai/glm-4.7" }) {
  return {
    model,
    session_id: session,
    cwd,
    reasoning_effort: "high",
  };
}

export const MODELS = [
  { header: true, name: "zai" },
  { name: "glm-4.7", current: true },
  { name: "glm-4.6" },
  { header: true, name: "openai-compatible" },
  { name: "local-llama" },
];

export const SLASH_MATCHES = [
  { name: "team", description: "Manage the current Team" },
  { name: "theme", description: "Switch the CLI color theme" },
];

export const BLUEPRINTS = [
  { id: "reviewer", name: "Code Reviewer", description: "Reviews diffs against the project rules" },
  { id: "documenter", name: "Documenter", description: "Keeps README and RIND.md current" },
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
  bg_id: "bg-1",
  status: "running",
  command: "npm test",
  stdout: "▶ tour-stage.test.js (21/21)\n▶ tour-render.test.js (11/11)",
};

export const DELEGATES = [
  {
    agent_id: "test-specialist",
    status: "running",
    task: "Cover the unicode parser cases",
    summary: "",
  },
];

export const BOARD_PAGES = [
  {
    index: 1,
    count: 2,
    breakdown: {
      context_window_tokens: 200000,
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
      by_model: [{ model: "zai/glm-4.7", tokens: 102000 }],
      recent_sessions: [{ session_id: "eff01a23", updated_at: "2026-09-17T10:31:22Z", tokens: 31000 }],
    },
  },
];

export const PROVIDERS = [
  "zai · Z.ai · not configured",
  "openai · OpenAI · not configured",
  "local · Local endpoint · configured (settings)",
];

export const SKILLS = [
  { name: "release-notes", scope: "project", description: "Draft release notes from the JSONL log", path: "~/demo/.rind/skills/release-notes/SKILL.md" },
  { name: "commit-lint", scope: "user", description: "Check commit messages against the repo style", path: "~/.rind/skills/commit-lint/SKILL.md" },
];

export const HELP_DECK = [
  { name: "compact", description: "Compact current session context" },
  { name: "context", description: "Show context composition and token usage" },
  { name: "fork", description: "Fork the current session" },
  { name: "team", description: "Manage the current Team" },
];
