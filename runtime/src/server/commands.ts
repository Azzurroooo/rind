import type { AgentRuntime } from "../core/turn-runner.js";
import type { SkillMetadata } from "../domain/models.js";
import {
  type JsonlSessionStore,
  displayTitle,
  normalizeSkillSources,
} from "../infrastructure/persistence/session-store.js";
import { resolveProjectDocPath, resolveUserDocPath } from "../infrastructure/rind-docs.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, loadSettings } from "../infrastructure/settings.js";
import {
  IMPORT_SOURCES,
  type ScannedSource,
  SkillInvocationParser,
  type SkillRepository,
  type SkillScan,
} from "../infrastructure/skills.js";
import { buildRindInitPrompt } from "../prompts.js";

// --- Contracts (from agent/runtime/server/commands/contracts.py) ---

export interface SlashCommandContext {
  readonly runtime: AgentRuntime | null;
  readonly session: JsonlSessionStore;
  readonly debug?: boolean;
  readonly workspace_root?: string | null;
  readonly compact_context?: (() => Promise<Record<string, unknown>>) | null;
  readonly draft?: Record<string, unknown> | null;
  readonly explain_selection?:
    | ((
        selection: Record<string, string>,
        source: Record<string, string> | null,
      ) => Promise<Record<string, unknown>>)
    | null;
  readonly skills: SkillRepository;
}

export class SlashCommandResult {
  readonly text: string;
  readonly display: Record<string, unknown> | null;
  readonly prompt_prefill: string;
  readonly next_prompt: Record<string, unknown> | null;

  constructor(
    text = "",
    options?: {
      display?: Record<string, unknown> | null;
      prompt_prefill?: string;
      next_prompt?: Record<string, unknown> | null;
    },
  ) {
    this.text = text;
    this.display = options?.display ?? null;
    this.prompt_prefill = options?.prompt_prefill ?? "";
    this.next_prompt = options?.next_prompt ?? null;
  }

  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = { text: this.text };
    if (this.display !== null) {
      result.display = this.display;
    }
    if (this.prompt_prefill) {
      result.prompt_prefill = this.prompt_prefill;
    }
    if (this.next_prompt !== null) {
      result.next_prompt = this.next_prompt;
    }
    return result;
  }
}

export type SlashHandler = (
  context: SlashCommandContext,
  args: string[],
) => string | SlashCommandResult | Promise<string | SlashCommandResult>;

export interface SlashCommandInfo {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly aliases: readonly string[];
  readonly handler: SlashHandler | null;
  readonly raw_args: boolean;
}

export function createSlashCommandInfo(options: {
  name: string;
  description: string;
  usage?: string;
  aliases?: readonly string[];
  handler?: SlashHandler | null;
  raw_args?: boolean;
}): SlashCommandInfo {
  return {
    name: options.name,
    description: options.description,
    usage: options.usage ?? "",
    aliases: options.aliases ?? [],
    handler: options.handler ?? null,
    raw_args: options.raw_args ?? false,
  };
}

// --- Formatting (from agent/runtime/server/commands/formatting.py) ---

export function displayValue(value: unknown, fallback = "unknown"): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function clipText(value: unknown, limit: number, options?: { strip?: boolean }): string {
  let text = String(value ?? "");
  if (options?.strip !== false) {
    text = text.trim();
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

export function singleLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\n/g, " ")
    .trim();
}

export function safeInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nonnegativeInt(value: unknown): number {
  return Math.max(0, safeInt(value ?? 0));
}

// --- /help (from agent/runtime/server/commands/help.py) ---

const HELP_GROUPS: ReadonlyArray<[string, readonly string[]]> = [
  ["Operate", ["status", "plan", "draft", "compact"]],
  ["Explore", ["sessions", "skill", "help"]],
  ["Configure", ["model", "login", "import"]],
];

function commandDisplay(info: SlashCommandInfo): Record<string, unknown> {
  return {
    name: info.name,
    description: info.description,
    usage: info.usage,
    aliases: [...info.aliases],
  };
}

function commandDisplayList(infos: readonly SlashCommandInfo[]): Record<string, unknown>[] {
  return infos.map(commandDisplay);
}

function findCommandInfo(
  infos: readonly SlashCommandInfo[],
  name: string,
): SlashCommandInfo | null {
  return infos.find(info => info.name === name || info.aliases.includes(name)) ?? null;
}

function aliasLabel(aliases: readonly string[]): string {
  return aliases.length === 1 ? "alias" : "aliases";
}

function formatAliases(aliases: readonly string[]): string {
  return aliases.map(a => `/${a}`).join(", ");
}

function formatHelpRow(info: SlashCommandInfo, commandWidth: number): string {
  const suffix =
    info.aliases.length > 0 ? ` (${aliasLabel(info.aliases)}: ${formatAliases(info.aliases)})` : "";
  return `  /${info.name.padEnd(commandWidth)}  ${info.description}${suffix}`;
}

export function renderHelp(commandInfos: readonly SlashCommandInfo[]): string {
  const byName = new Map(commandInfos.map(info => [info.name, info]));
  const commandWidth = commandInfos.reduce((max, info) => Math.max(max, info.name.length), 0);
  const used = new Set<string>();
  const body: string[] = ["```text"];
  for (const [title, names] of HELP_GROUPS) {
    const rows = names
      .map(name => byName.get(name))
      .filter((info): info is SlashCommandInfo => info !== undefined);
    if (rows.length === 0) continue;
    if (body.length > 1) body.push("");
    body.push(title);
    for (const info of rows) {
      body.push(formatHelpRow(info, commandWidth));
      used.add(info.name);
    }
  }
  const remaining = commandInfos.filter(info => !used.has(info.name));
  if (remaining.length > 0) {
    if (body.length > 1) body.push("");
    body.push("Other");
    for (const info of remaining) {
      body.push(formatHelpRow(info, commandWidth));
    }
  }
  body.push("```");
  return ["# Commands", "", ...body, "", "Use `/help <command>` for usage."].join("\n");
}

export function renderCommandHelp(
  commandInfos: readonly SlashCommandInfo[],
  command: string,
): string {
  const name = command.trim().replace(/^\/+/, "").toLowerCase();
  const info = findCommandInfo(commandInfos, name);
  if (!info) {
    return `Unknown command: /${name}\nRun /help to see available commands.`;
  }
  const lines = [
    `# /${info.name}`,
    "",
    info.description,
    "",
    "```text",
    "Usage",
    `  ${info.usage || "/" + info.name}`,
  ];
  if (info.aliases.length > 0) {
    lines.push("", "Aliases", `  ${formatAliases(info.aliases)}`);
  }
  lines.push("```");
  return lines.join("\n");
}

export function buildHelpCommand(
  commandInfos: () => readonly SlashCommandInfo[],
): SlashCommandInfo {
  const handleHelp: SlashHandler = async (_context, args) => {
    const commands = commandInfos();
    if (args.length > 1) {
      return "Usage: /help [command]";
    }
    if (args.length === 1) {
      const name = args[0]!.trim().replace(/^\/+/, "").toLowerCase();
      const info = findCommandInfo(commands, name);
      const text = renderCommandHelp(commands, args[0]!);
      if (!info) return text;
      return new SlashCommandResult(text, {
        display: {
          type: "help",
          commands: commandDisplayList(commands),
          command: commandDisplay(info),
        },
      });
    }
    return new SlashCommandResult(renderHelp(commands), {
      display: { type: "help", commands: commandDisplayList(commands) },
    });
  };

  return createSlashCommandInfo({
    name: "help",
    description: "Show commands",
    usage: "/help [command]",
    handler: handleHelp,
  });
}

// --- /status (from agent/runtime/server/commands/status.py) ---

const GROUP_TITLES: Readonly<Record<string, string>> = {
  model: "Model",
  provider: "Provider",
  conversation: "Conversation",
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  session: "this conversation",
  folder: "folder default",
  main_repository: "main repository default",
  settings: "settings.json",
};

const KIND_NOTES: Readonly<Record<string, string>> = {
  builtin: "built-in",
  custom: "custom · providers.json",
  overridden: "built-in · endpoint from providers.json",
};

function statusEntry(
  group: string,
  label: string,
  value: string,
  note = "",
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { group, label, value };
  if (note) entry.note = note;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) entry[k] = v;
    }
  }
  return entry;
}

function settingsEntry(): Record<string, unknown> {
  try {
    const settings = loadSettings();
    return statusEntry(
      "settings",
      "settings",
      String(settings.settings_path),
      settings.settings_exists ? "" : "not created · defaults apply",
    );
  } catch (exc) {
    return statusEntry(
      "settings",
      "settings",
      "unavailable",
      (exc as Error).message || String(exc),
      { tone: "warning" },
    );
  }
}

async function explainedSelection(
  context: SlashCommandContext,
  session: JsonlSessionStore,
  sessionId: string | null,
): Promise<Record<string, unknown>> {
  if (!context.explain_selection) return {};
  if (!sessionId) {
    const draft = context.draft ?? {};
    const draftStrings: Record<string, string> = {};
    for (const k of ["provider", "model", "reasoning_effort"]) {
      if (typeof draft[k] === "string") draftStrings[k] = draft[k] as string;
    }
    return await context.explain_selection(draftStrings, null);
  }
  const selection = {
    provider: String(session.provider || ""),
    model: String(session.model || ""),
    reasoning_effort: String(session.reasoningEffort || ""),
  };
  return await context.explain_selection(selection, { ...session.selectionSource });
}

function modelEntries(explained: Record<string, unknown>): Record<string, unknown>[] {
  return [
    statusEntry(
      "model",
      "model",
      displayValue(explained.model),
      SOURCE_LABELS[String(explained.model_source || "")] || "",
    ),
    statusEntry(
      "model",
      "effort",
      displayValue(explained.reasoning_effort || "unset"),
      SOURCE_LABELS[String(explained.effort_source || "")] || "",
    ),
  ];
}

function authEntry(connection: Record<string, unknown>): Record<string, unknown> {
  const auth = String(connection.auth || "");
  const credential = String(connection.credential || "");
  const envKey = String(connection.env_key || "");
  if (auth === "oauth") {
    const account = String(connection.account || "account");
    return statusEntry("provider", "auth", `${account} sign-in`, "OAuth", { note_tone: "accent" });
  }
  if (credential === "stored") {
    return statusEntry("provider", "auth", "API key", "saved login");
  }
  if (credential === "environment") {
    return statusEntry(
      "provider",
      "auth",
      "API key",
      envKey ? `env ${envKey}` : "environment variable",
    );
  }
  return statusEntry(
    "provider",
    "auth",
    "not signed in",
    envKey ? `/login or set ${envKey}` : "/login",
    { tone: "warning", actions: ["/login"] },
  );
}

function providerEntries(explained: Record<string, unknown>): Record<string, unknown>[] {
  const connection =
    explained.connection && typeof explained.connection === "object"
      ? (explained.connection as Record<string, unknown>)
      : null;
  if (!connection) {
    return [
      statusEntry(
        "provider",
        "provider",
        displayValue(explained.provider),
        "not configured · /login or /model",
        { tone: "warning", actions: ["/login", "/model"] },
      ),
    ];
  }
  const kind = String(connection.kind || "builtin");
  return [
    statusEntry("provider", "provider", displayValue(connection.name), KIND_NOTES[kind] || "", {
      note_tone: kind !== "builtin" ? "accent" : "",
    }),
    authEntry(connection),
    statusEntry("provider", "endpoint", displayValue(connection.endpoint), String(connection.api || "")),
  ];
}

async function nameValue(
  session: JsonlSessionStore,
  sessionId: string | null,
  draft?: Record<string, unknown> | null,
): Promise<[string, string]> {
  if (!sessionId) {
    const pending = String((draft || {}).name || "").trim();
    return pending
      ? [pending, "applies when the conversation starts"]
      : ["unset", "shown by its first message"];
  }
  const meta = await session.getMetadata();
  const name = meta.name;
  if (typeof name === "string" && name.trim()) {
    return [name, ""];
  }
  const title = displayTitle(meta);
  return title ? ["unset", `shown as "${title}"`] : ["unset", "shown by its first message"];
}

function numericPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0.0;
}

function formatCount(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? "");
  if (Math.abs(num) >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return String(Math.trunc(num));
}

function formatPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0.0%";
  return `${(value * 100).toFixed(1)}%`;
}

function usageDisplay(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    input_tokens: nonnegativeInt(usage.input_tokens),
    context_window_tokens: nonnegativeInt(usage.context_window_tokens),
    context_usage_percent: numericPercent(usage.context_usage_percent),
    cached_input_tokens: nonnegativeInt(usage.cached_input_tokens),
    cache_hit_rate: numericPercent(usage.cache_hit_rate),
    output_tokens: nonnegativeInt(usage.output_tokens),
  };
}

function usageLines(usage: Record<string, unknown>): string[] {
  const contextPercent = numericPercent(usage.context_usage_percent);
  const contextWindow = nonnegativeInt(usage.context_window_tokens);
  const inputTokens = nonnegativeInt(usage.input_tokens);
  const cachedTokens = nonnegativeInt(usage.cached_input_tokens);
  const outputTokens = nonnegativeInt(usage.output_tokens);
  const limit = contextWindow > 0 ? ` / ${formatCount(contextWindow)} tokens` : "";
  const lines: string[] = [];
  if (contextWindow > 0) {
    const filled = Math.min(10, Math.max(0, Math.round(contextPercent * 10)));
    lines.push(
      `context: ${"▮".repeat(filled)}${"▯".repeat(10 - filled)} ${formatPercent(contextPercent)}`,
    );
  }
  lines.push(
    `input: ${formatCount(inputTokens)}${limit}`,
    `cached: ${formatCount(cachedTokens)} · ${formatPercent(usage.cache_hit_rate)} hit`,
    `output: ${formatCount(outputTokens)}`,
  );
  return lines;
}

function selectionSummary(selection: Record<string, unknown>): string {
  const model = ["provider", "model"]
    .filter(k => Boolean(selection[k]))
    .map(k => String(selection[k] || ""))
    .join(" / ");
  const effort = String(selection.reasoning_effort || "");
  return effort ? `${model} · ${effort}` : model;
}

function entryLine(entry: Record<string, unknown>): string {
  const note = String(entry.note || "");
  return `${entry.label ?? ""}: ${entry.value ?? ""}` + (note ? ` · ${note}` : "");
}

export function renderStatusDisplay(display: Record<string, unknown>): string {
  const lines = ["```text"];
  const selection =
    display.selection && typeof display.selection === "object"
      ? (display.selection as Record<string, unknown>)
      : null;
  if (selection && selection.model) {
    lines.push(`Status: ${selectionSummary(selection)}`, "");
  }
  const entries = (Array.isArray(display.entries) ? display.entries : []).filter(
    (e): e is Record<string, unknown> => Boolean(e && typeof e === "object"),
  );
  for (const [group, title] of Object.entries(GROUP_TITLES)) {
    const grouped = entries.filter(e => e.group === group);
    if (grouped.length > 0) {
      lines.push(`${title}:`);
      for (const e of grouped) {
        lines.push(`  ${entryLine(e)}`);
      }
      lines.push("");
    }
  }
  lines.push("Context:");
  const usageItems = Array.isArray(display.usage) ? display.usage : [];
  const usage =
    usageItems[0] && typeof usageItems[0] === "object"
      ? (usageItems[0] as Record<string, unknown>)
      : null;
  for (const line of usage ? usageLines(usage) : ["no completed sampling yet"]) {
    lines.push(`  ${line}`);
  }
  const footer = entries.filter(e => !(String(e.group || "") in GROUP_TITLES)).map(entryLine);
  if (footer.length > 0) {
    lines.push("", ...footer);
  }
  lines.push("```");
  return lines.join("\n");
}

export async function buildStatusDisplay(
  context: SlashCommandContext,
): Promise<Record<string, unknown>> {
  const session = context.session;
  const sessionId = session.sessionId;
  const entries: Record<string, unknown>[] = [];
  let selection: Record<string, string> = {};
  if (context.explain_selection) {
    try {
      const explained = await explainedSelection(context, session, sessionId);
      selection = {
        provider: String(explained.provider || ""),
        model: String(explained.model || ""),
        reasoning_effort: String(explained.reasoning_effort || ""),
      };
      entries.push(...modelEntries(explained));
      entries.push(...providerEntries(explained));
    } catch (exc) {
      entries.push(
        statusEntry("provider", "provider", "unavailable", (exc as Error).message || String(exc), {
          tone: "warning",
        }),
      );
    }
  }
  const [nameVal, nameNote] = await nameValue(session, sessionId, context.draft);
  entries.push(
    sessionId
      ? statusEntry("conversation", "session", displayValue(sessionId), "")
      : statusEntry("conversation", "session", "none", "the first message starts it"),
    statusEntry("conversation", "name", nameVal, nameNote),
    settingsEntry(),
  );
  let usage: Record<string, unknown> | null = null;
  try {
    usage = await session.getLatestAssistantSamplingUsage();
  } catch {
    usage = null;
  }
  return {
    type: "status",
    selection,
    entries,
    usage: usage ? [usageDisplay(usage)] : [],
  };
}

export const STATUS_COMMAND = createSlashCommandInfo({
  name: "status",
  description: "Show model, provider, conversation and context use",
  usage: "/status",
  handler: async (context, args) => {
    if (args.length > 0) {
      return "Usage: /status";
    }
    const display = await buildStatusDisplay(context);
    return new SlashCommandResult(renderStatusDisplay(display), { display });
  },
});

// --- /sessions (from agent/runtime/server/commands/sessions.py) ---

function parseSessionsLimit(args: readonly string[], defLimit = 100, maxLimit = 100): number | null {
  if (args.length === 0) return defLimit;
  if (args.length !== 1) return null;
  const parsed = Number(args[0]);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, maxLimit);
}

function formatSessionSize(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const obj = value as Record<string, unknown>;
  const messages = nonnegativeInt(obj.messages);
  const tools = nonnegativeInt(obj.tool_calls);
  return `${messages} msg, ${tools} tool`;
}

export const SESSIONS_COMMAND = createSlashCommandInfo({
  name: "sessions",
  description: "List recent sessions",
  usage: "/sessions [limit]",
  handler: async (context, args) => {
    const limit = parseSessionsLimit(args, 100, 100);
    if (limit === null) {
      return "Usage: /sessions [limit]";
    }
    let sessions: Record<string, unknown>[];
    try {
      sessions = await context.session.list_recent_sessions(limit);
    } catch (exc) {
      return `Command failed: ${(exc as Error).message || String(exc)}`;
    }
    const currentId = String(context.session.sessionId || "");
    if (sessions.length === 0) {
      return new SlashCommandResult("No recent sessions.", {
        display: {
          type: "sessions",
          sessions: [],
          current_session_id: currentId,
          limit,
          resume_command: "/sessions",
        },
      });
    }
    const lines = ["Recent sessions:"];
    const displaySessions: Record<string, unknown>[] = [];
    for (const item of sessions.slice(0, limit)) {
      if (!item || typeof item !== "object") continue;
      const sessionId = displayValue(item.id);
      const marker = currentId && sessionId === currentId ? " (current)" : "";
      const updated = displayValue(item.updated_at);
      const title = clipText(displayValue(item.title), 40);
      const sizeData =
        item.size && typeof item.size === "object" && !Array.isArray(item.size)
          ? (item.size as Record<string, unknown>)
          : null;
      const size = formatSessionSize(sizeData);
      const preview = clipText(singleLine(item.preview), 56);
      const suffix = preview ? ` | ${preview}` : "";
      lines.push(`- ${sessionId}${marker} | ${updated} | ${title} | ${size}${suffix}`);
      displaySessions.push({
        id: sessionId,
        current: Boolean(currentId && sessionId === currentId),
        updated_at: updated,
        title: displayValue(item.title),
        messages: sizeData ? nonnegativeInt(sizeData.messages) : null,
        tool_calls: sizeData ? nonnegativeInt(sizeData.tool_calls) : null,
        preview: singleLine(item.preview),
      });
    }
    lines.push("Use /sessions to switch sessions.");
    return new SlashCommandResult(lines.join("\n"), {
      display: {
        type: "sessions",
        sessions: displaySessions,
        current_session_id: currentId,
        limit,
        resume_command: "/sessions",
      },
    });
  },
});

// --- /skill & /import (from agent/runtime/server/commands/skill.py & import_skills.py) ---

export async function scanSkills(context: SlashCommandContext): Promise<SkillScan> {
  const imports = context.session.sessionId
    ? await context.session.getSkillSources()
    : normalizeSkillSources((context.draft || {}).skill_sources);
  return context.skills.scan(imports);
}

function skillDisplay(
  skill: SkillMetadata,
  enabled: boolean,
  effective: Map<string, SkillMetadata>,
): Record<string, unknown> {
  const winner = effective.get(skill.name.toLowerCase());
  let status: "off" | "overridden" | "active" | "hidden";
  if (!enabled) {
    status = "off";
  } else if (winner && winner.location !== skill.location) {
    status = "overridden";
  } else {
    status = skill.model_invocable ? "active" : "hidden";
  }
  const entry: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    status,
  };
  if (status === "overridden" && winner) {
    entry.overridden_by = winner.location;
  }
  return entry;
}

function sourceDisplay(
  scanned: ScannedSource,
  effective: Map<string, SkillMetadata>,
): Record<string, unknown> {
  return {
    label: scanned.source.label,
    paths: [...scanned.source.paths],
    enabled: scanned.enabled,
    importable: IMPORT_SOURCES.includes(scanned.source.id),
    skills: scanned.skills.map(skill => skillDisplay(skill, scanned.enabled, effective)),
  };
}

function skillsText(
  sources: readonly Record<string, unknown>[],
  problems: readonly Record<string, unknown>[],
): string {
  const lines: string[] = [];
  for (const source of sources) {
    const paths = (source.paths as string[]).join(" · ");
    const skills = source.skills as Record<string, unknown>[];
    if (!source.enabled) {
      lines.push(
        `${source.label as string}  off  ${paths} · ${skills.length} skill(s)  (/import to enable)`,
      );
      continue;
    }
    if (skills.length === 0) continue;
    lines.push(`${source.label as string}  ${paths}`);
    for (const skill of skills) {
      const status = String(skill.status || "active");
      const desc = String(skill.description || "");
      const note =
        status === "active"
          ? desc
          : status === "hidden"
            ? `hidden from the model · ${desc}`
            : `overridden by ${String(skill.overridden_by || "")}`;
      lines.push(`  ${skill.name as string}  ${note}`);
    }
  }
  if (problems.length > 0) {
    lines.push("Problems");
    for (const problem of problems) {
      lines.push(`  ${problem.location as string}  ${problem.message as string}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No skills found.";
}

export const SKILL_COMMAND = createSlashCommandInfo({
  name: "skill",
  description: "List skills and where they come from",
  usage: "/skill",
  handler: async (context, args) => {
    if (args.length > 0) {
      return "Usage: /skill";
    }
    const scan = await scanSkills(context);
    const effective = scan.effective();
    const sources = scan.sources.map(s => sourceDisplay(s, effective));
    const problems: Record<string, unknown>[] = [];
    for (const scanned of scan.sources) {
      if (!scanned.enabled) continue;
      for (const problem of scanned.problems) {
        problems.push({ location: problem.location, message: problem.message });
      }
    }
    const display = { type: "skills", sources, problems };
    return new SlashCommandResult(skillsText(sources, problems), { display });
  },
});

const IMPORT_USAGE = `/import [<source>=on|off ...]   sources: ${IMPORT_SOURCES.join(", ")}`;
const IMPORT_APPLIES = "This breaks the prompt cache: the next model request will not hit it.";

function parseImportChanges(args: readonly string[]): Record<string, boolean> | null {
  const changes: Record<string, boolean> = {};
  for (const arg of args) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx <= 0) return null;
    const source = arg.slice(0, eqIdx);
    const value = arg.slice(eqIdx + 1);
    if (!IMPORT_SOURCES.includes(source) || (value !== "on" && value !== "off")) {
      return null;
    }
    changes[source] = value === "on";
  }
  return changes;
}

export const IMPORT_COMMAND = createSlashCommandInfo({
  name: "import",
  description: "Choose the Claude and Codex skills this conversation reads",
  usage: IMPORT_USAGE,
  handler: async (context, args) => {
    const changes = parseImportChanges(args);
    if (changes === null) {
      return `Usage: ${IMPORT_USAGE}`;
    }
    const hasChanges = Object.keys(changes).length > 0;
    if (hasChanges) {
      if (!context.session.sessionId) {
        return "/import <source>=on|off changes a conversation. Send your first message to start one.";
      }
      const current = await context.session.getSkillSources();
      await context.session.setSkillSources({ ...current, ...changes });
      if (context.runtime) {
        await context.runtime.syncSkillCatalog();
      }
    }
    const scan = await scanSkills(context);
    const sources = scan.sources
      .filter(s => IMPORT_SOURCES.includes(s.source.id))
      .map(s => ({
        id: s.source.id,
        label: s.source.label,
        paths: [...s.source.paths],
        count: s.skills.length,
        enabled: s.enabled,
      }));
    const lines = sources.map(
      s => `[${s.enabled ? "x" : " "}] ${s.id}  ${s.paths.join(" · ")}  ${s.count} skill(s)`,
    );
    const text = [
      ...(hasChanges ? [`Skill imports updated. ${IMPORT_APPLIES}`] : []),
      ...lines,
      ...(hasChanges ? [] : [`Usage: ${IMPORT_USAGE}`]),
    ].join("\n");
    return new SlashCommandResult(text, { display: { type: "skill_imports", sources } });
  },
});

// --- /init (from agent/runtime/server/commands/init_rind_doc.py) ---

export const INIT_COMMAND = createSlashCommandInfo({
  name: "init",
  description: "Draft RIND.md",
  usage: "/init [project|user]",
  handler: async (context, args) => {
    if (args.length > 1) {
      return new SlashCommandResult("Usage: /init [project|user]");
    }
    const scope = args[0] ? args[0].toLowerCase() : "project";
    if (scope !== "project" && scope !== "user") {
      return new SlashCommandResult("Usage: /init [project|user]");
    }
    const target =
      scope === "project" ? resolveProjectDocPath(context.workspace_root) : resolveUserDocPath();
    const prompt = buildRindInitPrompt(scope, target);
    return new SlashCommandResult(`Initializing ${scope} RIND.md: ${target}`, {
      next_prompt: {
        input: `Initialize ${scope} RIND.md at ${target}`,
        transient_system_messages: [
          {
            role: "system",
            content: prompt,
            _context_kind: "rind_init",
          },
        ],
      },
    });
  },
});

// --- /compact (from agent/runtime/server/commands/compact.py) ---

export const COMPACT_COMMAND = createSlashCommandInfo({
  name: "compact",
  description: "Compact current session context",
  usage: "/compact",
  handler: async context => {
    const compactContext = context.compact_context;
    if (typeof compactContext !== "function") {
      return "Compact is not supported by this runtime.";
    }
    if (context.runtime?.turnActive) {
      return "Cannot compact while a turn is running. Wait for it to finish or interrupt it first.";
    }
    let record: Record<string, unknown>;
    try {
      record = await compactContext();
    } catch (exc) {
      return (exc as Error).message || String(exc);
    }
    const source =
      record && typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : {};
    const start = source.message_start_index ?? "?";
    const end = source.message_end_index_exclusive ?? "?";
    const toolCount = Array.isArray(source.tool_call_ids) ? source.tool_call_ids.length : 0;
    return new SlashCommandResult(
      [
        "Compact complete.",
        `- id: ${displayValue(record?.id)}`,
        `- source: messages[${start}:${end}]`,
        `- tool calls: ${toolCount}`,
      ].join("\n"),
    );
  },
});

// --- /model (from agent/runtime/server/commands/model.py) ---

function normalizeModelName(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text || /\s/.test(text) || text.length > 128) return null;
  return text;
}

function defaultModel(): string {
  try {
    return loadSettings().model;
  } catch {
    return DEFAULT_MODEL;
  }
}

export const MODEL_COMMAND = createSlashCommandInfo({
  name: "model",
  description: "Show or change the active model",
  usage: "/model | /model set <model>",
  handler: async (context, args) => {
    if (args.length === 0) {
      const active = displayValue(context.session.model);
      const configured = displayValue(defaultModel());
      if (active === configured) {
        return `Model: ${active}`;
      }
      return `Model:\n- active: ${active}\n- default: ${configured}`;
    }
    if (args.length !== 2 || args[0]!.toLowerCase() !== "set") {
      return "Usage: /model or /model set <model>";
    }
    const model = normalizeModelName(args[1]);
    if (!model) {
      return "Usage: /model set <model>";
    }
    try {
      const provider = String(context.session.provider || DEFAULT_PROVIDER);
      await context.session.updateSelection(provider, model);
    } catch (exc) {
      return `Command failed: ${(exc as Error).message || String(exc)}`;
    }
    const sessionModel = displayValue(model);
    if (context.runtime !== null) {
      return `Model changed to ${sessionModel} (session only) · applies from the next turn; this turn keeps its model`;
    }
    return `Model changed to ${sessionModel} (session only)`;
  },
});

// --- /rename (from agent/runtime/server/commands/rename.py) ---

const RENAME_USAGE = "/rename <name> · /rename --reset";
const RENAME_RESET = "--reset";

export const RENAME_COMMAND = createSlashCommandInfo({
  name: "rename",
  description: "Name this conversation (otherwise it is shown by its first message)",
  usage: RENAME_USAGE,
  raw_args: true,
  handler: async (context, args) => {
    const text = args[0] ? args[0].trim() : "";
    const session = context.session;
    if (!text) {
      const meta = await session.getMetadata();
      const current = displayTitle(meta) || "(no title yet)";
      const source = meta.name ? "its name" : "its first message";
      return `Shown as: ${current} (${source}).\nUsage: ${RENAME_USAGE}`;
    }
    let result: { name: string | null; title: string };
    try {
      result = await session.set_name(text === RENAME_RESET ? null : text);
    } catch (exc) {
      return `${(exc as Error).message || String(exc)} Usage: ${RENAME_USAGE}`;
    }
    const sessionId = String(session.sessionId || "");
    const message = result.name
      ? `Named: ${result.name}`
      : `Name cleared; shown as: ${result.title || "(no title yet)"}`;
    return new SlashCommandResult(message, {
      display: {
        type: "session_renamed",
        session_id: sessionId,
        name: result.name,
        title: result.title,
      },
    });
  },
});

// --- Catalog & Router (from agent/runtime/server/commands/catalog.py & router.py) ---

export function buildCommandInfos(): SlashCommandInfo[] {
  const commands: SlashCommandInfo[] = [];
  commands.push(buildHelpCommand(() => commands));
  commands.push(
    STATUS_COMMAND,
    SESSIONS_COMMAND,
    SKILL_COMMAND,
    IMPORT_COMMAND,
    INIT_COMMAND,
    COMPACT_COMMAND,
    MODEL_COMMAND,
    RENAME_COMMAND,
  );
  return commands;
}

function splitShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  let escaping = false;
  let inToken = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      inToken = true;
      continue;
    }
    if (ch === "\\" && (!inQuotes || quoteChar === '"')) {
      escaping = true;
      inToken = true;
      continue;
    }
    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuotes = true;
      quoteChar = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaping || inQuotes) {
    throw new Error("No closing quotation");
  }
  if (inToken) {
    args.push(current);
  }
  return args;
}

export class SlashCommandRouter {
  private readonly _skillInvocationParser = new SkillInvocationParser();
  private readonly _commandInfos: readonly SlashCommandInfo[];
  private readonly _commandsByName = new Map<string, SlashCommandInfo>();

  constructor(commandInfos: Iterable<SlashCommandInfo> = buildCommandInfos()) {
    this._commandInfos = Array.from(commandInfos);
    this._validateCommands();
  }

  commandNames(): string[] {
    return Array.from(this._commandsByName.keys()).sort();
  }

  commandInfos(): SlashCommandInfo[] {
    return [...this._commandInfos].sort((a, b) => a.name.localeCompare(b.name));
  }

  knows(name: string): boolean {
    return this._commandsByName.has(name.trim().toLowerCase());
  }

  async execute(rawInput: string, context: SlashCommandContext): Promise<SlashCommandResult> {
    try {
      const invocations = this._skillInvocationParser.parse(rawInput || "");
      if (invocations.length > 0 && invocations[0]!.syntax === "slash") {
        if (
          context.skills &&
          !(await scanSkills(context)).effective().has(invocations[0]!.name.toLowerCase())
        ) {
          return new SlashCommandResult(`Unknown Skill: ${invocations[0]!.name}`);
        }
        return new SlashCommandResult("", { next_prompt: { input: rawInput } });
      }
      const [name, rest] = this._split(rawInput);
      const info = this._commandsByName.get(name);
      if (!info || !info.handler) {
        return new SlashCommandResult(
          `Unknown command: /${name}\nRun /help to see available commands.`,
        );
      }
      const args = info.raw_args ? [rest] : this._parse(rawInput)[1];
      const result = await info.handler(context, args);
      return result instanceof SlashCommandResult
        ? result
        : new SlashCommandResult(String(result || ""));
    } catch (exc) {
      return new SlashCommandResult(`Command failed: ${(exc as Error).message || String(exc)}`);
    }
  }

  private _validateCommands(): void {
    const names = new Set<string>();
    const aliases = new Set<string>();
    for (const info of this._commandInfos) {
      const name = info.name.trim().toLowerCase();
      if (!name) throw new Error("Command name must not be empty.");
      if (typeof info.handler !== "function") {
        throw new Error(`Command handler is required: ${name}`);
      }
      if (names.has(name)) throw new Error(`Duplicate command name: ${name}`);
      if (aliases.has(name)) throw new Error(`Command name conflicts with alias: ${name}`);
      names.add(name);
      this._commandsByName.set(name, info);
      for (const alias of info.aliases) {
        const normAlias = String(alias).trim().toLowerCase();
        if (!normAlias) throw new Error(`Command alias must not be empty: ${name}`);
        if (names.has(normAlias) || aliases.has(normAlias)) {
          throw new Error(`Duplicate command alias: ${normAlias}`);
        }
        aliases.add(normAlias);
        this._commandsByName.set(normAlias, info);
      }
    }
  }

  private _split(rawInput: string): [string, string] {
    const text = rawInput.trim();
    if (!text.startsWith("/") || text.length === 1) {
      throw new Error("Slash command must start with '/'.");
    }
    const body = text.slice(1);
    const spaceIdx = body.indexOf(" ");
    if (spaceIdx === -1) {
      return [body.toLowerCase(), ""];
    }
    return [body.slice(0, spaceIdx).toLowerCase(), body.slice(spaceIdx + 1)];
  }

  private _parse(rawInput: string): [string, string[]] {
    const text = rawInput.trim();
    if (!text.startsWith("/")) {
      throw new Error("Slash command must start with '/'.");
    }
    const parts = splitShellArgs(text.slice(1));
    if (parts.length === 0) {
      throw new Error("Missing command name.");
    }
    return [parts[0]!.toLowerCase(), parts.slice(1)];
  }
}
