// Command registry (audit #9/#10, opencode pattern): ONE source of truth that
// feeds the Ctrl/Cmd+K palette, the Composer's "/" autocomplete and any
// keybind hints. Nothing renders a keybind or command list that is not
// resolved from here.
//
// Each entry: { id, title, category, keywords, slash?, keybind?, run(ctx, argument) }.
// `run` receives the App-provided ctx; commands stay declarative so tests can
// execute them against a stub ctx.

export const COMMAND_CATEGORIES = Object.freeze({
  session: "Session",
  model: "Model",
  context: "Context",
  transcript: "Transcript",
  view: "View",
  server: "Server commands",
});

// Server-side slash commands executed verbatim via rind/command/execute.
const SERVER_SLASH_COMMANDS = [
  { slash: "status", title: "Status", keywords: "status state" },
  { slash: "doctor", title: "Doctor", keywords: "doctor diagnose health" },
  { slash: "init", title: "Draft RIND.md", keywords: "init rind draft rind.md" },
  { slash: "skill", title: "Skills", keywords: "skill skills list" },
  { slash: "team", title: "Team", keywords: "team agents" },
  { slash: "config", title: "Config", keywords: "config settings" },
  { slash: "login", title: "Login settings", keywords: "login token auth" },
];

export function buildCommands(ctx = {}) {
  const runServer = (name) => (context, argument) => context.runServerSlash?.(name, argument || "");
  const commands = [
    {
      id: "session.new",
      title: "New session",
      category: COMMAND_CATEGORIES.session,
      keywords: "new session create",
      slash: "new",
      run: (context) => context.newSession?.(),
    },
    {
      id: "session.switch",
      title: "Switch session",
      category: COMMAND_CATEGORIES.session,
      keywords: "sessions switch search",
      slash: "sessions",
      run: (context) => context.focusSessions?.(),
    },
    {
      id: "model.select",
      title: "Model",
      category: COMMAND_CATEGORIES.model,
      keywords: "model select switch",
      slash: "model",
      run: (context, argument) => (argument ? context.setModel?.(argument) : context.focusModel?.()),
    },
    {
      id: "model.effort",
      title: "Reasoning effort",
      category: COMMAND_CATEGORIES.model,
      keywords: "effort reasoning",
      slash: "effort",
      run: (context, argument) => (argument ? context.setEffort?.(argument) : context.focusEffort?.()),
    },
    {
      id: "context.compact",
      title: "Compact context",
      category: COMMAND_CATEGORIES.context,
      keywords: "compact context",
      slash: "compact",
      run: (context) => context.compact?.(),
    },
    {
      id: "context.goal",
      title: "Goal",
      category: COMMAND_CATEGORIES.context,
      keywords: "goal objective",
      slash: "goal",
      run: (context, argument) => (argument ? context.runGoal?.(argument) : context.focusGoal?.()),
    },
    {
      id: "turn.stop",
      title: "Stop",
      category: COMMAND_CATEGORIES.transcript,
      keywords: "stop cancel interrupt esc",
      slash: "stop",
      keybind: "Esc ×2",
      run: (context) => context.stopTurn?.(),
    },
    {
      id: "transcript.latest",
      title: "Jump to latest",
      category: COMMAND_CATEGORIES.transcript,
      keywords: "latest bottom scroll follow",
      run: (context) => context.scrollToLatest?.(),
    },
    {
      id: "view.theme",
      title: "Theme",
      category: COMMAND_CATEGORIES.view,
      keywords: "theme light dark",
      slash: "theme",
      run: (context) => context.toggleTheme?.(),
    },
    {
      id: "transcript.clearInput",
      title: "Clear input",
      category: COMMAND_CATEGORIES.transcript,
      keywords: "clear draft composer input",
      slash: "clear",
      run: (context) => context.clearInput?.(),
    },
    {
      id: "view.focusComposer",
      title: "Focus composer",
      category: COMMAND_CATEGORIES.view,
      keywords: "focus composer input",
      run: (context) => context.focusComposer?.(),
    },
    {
      id: "view.help",
      title: "Help",
      category: COMMAND_CATEGORIES.view,
      keywords: "help commands keybinds",
      slash: "help",
      run: (context) => context.showHelp?.(),
    },
  ];
  for (const server of SERVER_SLASH_COMMANDS) {
    commands.push({
      id: `server.${server.slash}`,
      title: server.title,
      category: COMMAND_CATEGORIES.server,
      keywords: server.keywords,
      slash: server.slash,
      run: runServer(server.slash),
    });
  }
  return commands;
}

// Fuzzy filter for the palette: subsequence match over title/keywords/id with
// prefix > word-boundary > subsequence scoring; stable, no dependencies.
export function filterCommands(commands, query) {
  const clean = String(query || "").trim().toLowerCase();
  if (!clean) return [...commands];
  const scored = [];
  for (const command of commands) {
    const haystacks = [command.title, command.keywords || "", command.id, categoryLabel(command)];
    let best = -1;
    for (const haystack of haystacks) {
      const score = fuzzyScore(String(haystack || "").toLowerCase(), clean);
      if (score > best) best = score;
    }
    if (best >= 0) scored.push({ command, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.command.id.localeCompare(b.command.id));
  return scored.map((entry) => entry.command);
}

// Composer "/" autocomplete sources the same registry: prefix match on the
// slash name only (typing "/" shows everything with a slash form).
export function matchingSlashCommands(commands, query) {
  const clean = String(query || "").toLowerCase();
  return commands.filter((command) => command.slash && command.slash.startsWith(clean)).slice(0, 6);
}

// Exact slash-name resolution for submitted "/name ..." input.
export function findCommandBySlash(commands, name) {
  const clean = String(name || "").toLowerCase();
  if (!clean) return null;
  return commands.find((command) => command.slash === clean) || null;
}

export function keybindHint(command) {
  return String(command?.keybind || "");
}

function categoryLabel(command) {
  return typeof command.category === "string" ? command.category : "";
}

function fuzzyScore(haystack, needle) {
  if (!haystack) return -1;
  const at = haystack.indexOf(needle);
  if (at === 0) return 100; // prefix
  if (at > 0) {
    const boundary = /[\s/._-]/.test(haystack[at - 1]);
    return boundary ? 80 : 60; // word boundary beats mid-word
  }
  // subsequence
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 30;
  }
  return -1;
}
