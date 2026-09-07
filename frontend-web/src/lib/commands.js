// Command registry (audit #9/#10, opencode pattern): ONE source of truth that
// feeds the Ctrl/Cmd+K palette, the Composer's "/" autocomplete and any
// keybind hints. Nothing renders a keybind or command list that is not
// resolved from here.
//
// Each entry: { id, title, category, keywords, slash?, keybind?, run(ctx, argument) }.
// `run` receives the App-provided ctx; commands stay declarative so tests can
// execute them against a stub ctx.

export const COMMAND_CATEGORIES = Object.freeze({
  session: "会话",
  model: "模型",
  context: "上下文",
  transcript: "转写",
  view: "界面",
  server: "服务端命令",
});

// Server-side slash commands executed verbatim via rind/command/execute.
const SERVER_SLASH_COMMANDS = [
  { slash: "status", title: "状态 status", keywords: "status 状态 zhuangtai" },
  { slash: "doctor", title: "诊断 doctor", keywords: "doctor 诊断 zhenduan" },
  { slash: "init", title: "起草 RIND.md init", keywords: "init rind draft" },
  { slash: "skill", title: "技能列表 skill", keywords: "skill 技能 jineng" },
  { slash: "team", title: "团队 team", keywords: "team 团队 tuandui" },
  { slash: "config", title: "配置 config", keywords: "config 配置 peizhi" },
  { slash: "login", title: "登录设置 login", keywords: "login 登录 denglu" },
];

export function buildCommands(ctx = {}) {
  const runServer = (name) => (context, argument) => context.runServerSlash?.(name, argument || "");
  const commands = [
    {
      id: "session.new",
      title: "新会话",
      category: COMMAND_CATEGORIES.session,
      keywords: "new 新会话 xinhuihua create session",
      slash: "new",
      run: (context) => context.newSession?.(),
    },
    {
      id: "session.switch",
      title: "切换会话",
      category: COMMAND_CATEGORIES.session,
      keywords: "sessions 切换会话 qieguihuihua switch search",
      slash: "sessions",
      run: (context) => context.focusSessions?.(),
    },
    {
      id: "model.select",
      title: "模型",
      category: COMMAND_CATEGORIES.model,
      keywords: "model 模型 moxing",
      slash: "model",
      run: (context, argument) => (argument ? context.setModel?.(argument) : context.focusModel?.()),
    },
    {
      id: "model.effort",
      title: "推理力度",
      category: COMMAND_CATEGORIES.model,
      keywords: "effort 推理力度 lililidu reasoning",
      slash: "effort",
      run: (context, argument) => (argument ? context.setEffort?.(argument) : context.focusEffort?.()),
    },
    {
      id: "context.compact",
      title: "压缩上下文",
      category: COMMAND_CATEGORIES.context,
      keywords: "compact 压缩上下文 yasuo context",
      slash: "compact",
      run: (context) => context.compact?.(),
    },
    {
      id: "context.goal",
      title: "目标",
      category: COMMAND_CATEGORIES.context,
      keywords: "goal 目标 mubiao objective",
      slash: "goal",
      run: (context, argument) => (argument ? context.runGoal?.(argument) : context.focusGoal?.()),
    },
    {
      id: "turn.stop",
      title: "停止",
      category: COMMAND_CATEGORIES.transcript,
      keywords: "stop 停止 tingzhi cancel interrupt esc",
      slash: "stop",
      keybind: "Esc ×2",
      run: (context) => context.stopTurn?.(),
    },
    {
      id: "transcript.latest",
      title: "回到最新",
      category: COMMAND_CATEGORIES.transcript,
      keywords: "latest 回到最新 huidaozuixin bottom scroll follow",
      run: (context) => context.scrollToLatest?.(),
    },
    {
      id: "view.theme",
      title: "主题",
      category: COMMAND_CATEGORIES.view,
      keywords: "theme 主题 zhuti light dark 亮色 暗色",
      slash: "theme",
      run: (context) => context.toggleTheme?.(),
    },
    {
      id: "transcript.clearInput",
      title: "清空输入",
      category: COMMAND_CATEGORIES.transcript,
      keywords: "clear 清空输入 qingkong draft composer",
      slash: "clear",
      run: (context) => context.clearInput?.(),
    },
    {
      id: "view.focusComposer",
      title: "聚焦输入框",
      category: COMMAND_CATEGORIES.view,
      keywords: "focus 聚焦输入框 jujiao composer input",
      run: (context) => context.focusComposer?.(),
    },
    {
      id: "view.help",
      title: "帮助",
      category: COMMAND_CATEGORIES.view,
      keywords: "help 帮助 bangzhu commands 快捷键",
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
