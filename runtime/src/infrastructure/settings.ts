import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelSelection } from "../domain/models.js";
import { __version__ } from "../version.js";
import { resolveRindHome } from "./paths.js";

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-4o-mini";
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

const DEFAULT_SETTINGS_OBJECT: Readonly<Record<string, string>> = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  reasoningEffort: "",
};

function sanitizeUserAgentToken(value: string): string {
  let out = "";
  for (const ch of String(value).trim()) {
    const code = ch.charCodeAt(0);
    if (
      code < 128 &&
      ((ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "-" ||
        ch === "_" ||
        ch === "." ||
        ch === "/")
    ) {
      out += ch;
    } else {
      out += "_";
    }
  }
  return out;
}

function sanitizeHeaderSegment(value: string): string {
  let out = "";
  for (const ch of String(value).trim()) {
    out += ch >= " " && ch <= "~" ? ch : "_";
  }
  return out || "unknown";
}

function terminalUserAgentToken(): string {
  if (process.env.WT_SESSION) {
    return "WindowsTerminal";
  }
  const termProgram = (process.env.TERM_PROGRAM || "").trim();
  if (termProgram) {
    const token = sanitizeUserAgentToken(termProgram);
    const version = sanitizeUserAgentToken((process.env.TERM_PROGRAM_VERSION || "").trim());
    if (token && version) {
      return `${token}/${version}`;
    }
    return token || "unknown";
  }
  const term = (process.env.TERM || "").trim();
  if (term) {
    return sanitizeUserAgentToken(term) || "unknown";
  }
  return "unknown";
}

export function buildDefaultUserAgent(): string {
  const osType =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "Darwin"
        : process.platform === "linux"
          ? "Linux"
          : os.type();
  const osName = sanitizeHeaderSegment(osType || "unknown");
  const osVersion = sanitizeHeaderSegment(os.release() || "unknown");
  const machine = sanitizeHeaderSegment((os.machine ? os.machine() : process.arch) || "unknown");
  const version = sanitizeUserAgentToken(__version__) || "unknown";
  const terminal = terminalUserAgentToken();
  return `rind/${version} (${osName} ${osVersion}; ${machine}) ${terminal}`;
}

export const DEFAULT_USER_AGENT = buildDefaultUserAgent();

export interface AppSettings {
  readonly settings_path: string;
  readonly settings_exists: boolean;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly user_agent: string;
  readonly server_token: string;
  readonly provider: string;
}

export function normalizeReasoningEffort(value: unknown): string {
  const effort = String(value ?? "").trim().toLowerCase();
  if (effort && !REASONING_EFFORT_SET.has(effort)) {
    throw new Error(`Reasoning effort must be one of ${REASONING_EFFORTS.join(", ")}.`);
  }
  return effort;
}

export function defaultSettingsPath(rindHome?: string): string {
  return path.resolve(resolveRindHome(rindHome), "settings.json");
}

export function ensureUserSettings(rindHome?: string): string {
  const filePath = defaultSettingsPath(rindHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(DEFAULT_SETTINGS_OBJECT, null, 2) + "\n", "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
  return filePath;
}

function readJsonObject(filePath: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid ${label}: ${filePath} (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid ${label}: ${filePath} must contain a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function buildSettings(settingsPath: string, data: Record<string, unknown>): AppSettings {
  let provider = stringField(data, "provider");
  if (!provider) {
    const baseUrl = stringField(data, "baseUrl");
    provider = baseUrl.includes("api.deepseek.com") ? "deepseek" : DEFAULT_PROVIDER;
  }
  return {
    settings_path: settingsPath,
    settings_exists: fs.existsSync(settingsPath),
    model: stringField(data, "model") || DEFAULT_MODEL,
    reasoning_effort: stringField(data, "reasoningEffort"),
    user_agent: DEFAULT_USER_AGENT,
    server_token: stringField(data, "serverToken"),
    provider,
  };
}

export function writeJsonAtomicSync(filePath: string, data: unknown, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      ...(mode !== undefined ? { mode } : {}),
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
  }
}

export function loadSettings(settingsPath?: string): AppSettings {
  const target = settingsPath ? path.resolve(settingsPath) : defaultSettingsPath();
  const data = fs.existsSync(target) ? readJsonObject(target, "settings.json") : {};
  return buildSettings(target, data);
}

export function saveSettings(
  options: {
    provider?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
  } = {},
  settingsPath?: string,
): AppSettings {
  const target = settingsPath ? path.resolve(settingsPath) : defaultSettingsPath();
  const data: Record<string, unknown> = fs.existsSync(target)
    ? { ...readJsonObject(target, "settings.json") }
    : { ...DEFAULT_SETTINGS_OBJECT };
  if (options.provider !== undefined && options.provider !== null) {
    data.provider = String(options.provider).trim() || DEFAULT_PROVIDER;
  }
  if (options.model !== undefined && options.model !== null) {
    data.model = String(options.model).trim() || DEFAULT_MODEL;
  }
  if (options.reasoning_effort !== undefined && options.reasoning_effort !== null) {
    data.reasoningEffort = normalizeReasoningEffort(options.reasoning_effort);
  }
  writeJsonAtomicSync(target, data);
  return buildSettings(target, data);
}

export type SelectionSourceKind = "folder" | "main_repository" | "settings";

export interface FolderSelection {
  readonly selection: ModelSelection;
  readonly model_source: SelectionSourceKind;
  readonly effort_source: SelectionSourceKind;
}

export function mainRepository(workspaceRoot: string): string | null {
  const marker = path.join(workspaceRoot, ".git");
  let commonDir: string;
  try {
    if (!fs.statSync(marker).isFile()) {
      return null;
    }
    const text = fs.readFileSync(marker, "utf8").trim();
    if (!text.startsWith("gitdir:")) {
      return null;
    }
    const rawGitDir = text.slice("gitdir:".length).trim();
    const gitDir = path.resolve(path.dirname(marker), rawGitDir);
    const commonFile = path.join(gitDir, "commondir");
    if (fs.existsSync(commonFile) && fs.statSync(commonFile).isFile()) {
      commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim());
    } else {
      commonDir = path.dirname(path.dirname(gitDir));
    }
  } catch {
    return null;
  }
  try {
    if (path.basename(commonDir) !== ".git" || !fs.statSync(path.dirname(commonDir)).isDirectory()) {
      return null;
    }
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

export const gitCommonWorkspaceRoot = mainRepository;

function workspaceKey(workspaceRoot: string): string {
  const expanded = workspaceRoot.startsWith("~")
    ? path.join(os.homedir(), workspaceRoot.slice(1))
    : workspaceRoot;
  const resolved = path.resolve(expanded);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class WorkspaceDefaults {
  readonly path: string;

  constructor(storePath?: string | null) {
    const raw = storePath || path.join(resolveRindHome(), "workspaces.json");
    const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
    this.path = path.resolve(expanded);
  }

  get(workspaceRoot: string): Record<string, string> {
    const entry = this.read()[workspaceKey(workspaceRoot)];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof v === "string") {
        result[k] = v;
      }
    }
    return result;
  }

  set_model(workspaceRoot: string, provider: string, model: string): void {
    const cleanProvider = String(provider || "").trim();
    const cleanModel = String(model || "").trim();
    if (!cleanProvider || !cleanModel) {
      throw new Error("A folder default model needs both a connection and a model.");
    }
    this.update(workspaceRoot, { provider: cleanProvider, model: cleanModel });
  }

  setModel(workspaceRoot: string, provider: string, model: string): void {
    this.set_model(workspaceRoot, provider, model);
  }

  set_reasoning_effort(workspaceRoot: string, effort: string): void {
    const clean = normalizeReasoningEffort(effort);
    if (!clean) {
      throw new Error("Reasoning effort is required.");
    }
    this.update(workspaceRoot, { reasoning_effort: clean });
  }

  setReasoningEffort(workspaceRoot: string, effort: string): void {
    this.set_reasoning_effort(workspaceRoot, effort);
  }

  unset(workspaceRoot: string, group: "model" | "reasoning_effort" | string): boolean {
    const keys = group === "model" ? ["provider", "model"] : ["reasoning_effort"];
    const data = this.read();
    const key = workspaceKey(workspaceRoot);
    const current = data[key] && typeof data[key] === "object" && !Array.isArray(data[key])
      ? (data[key] as Record<string, unknown>)
      : {};
    const entry: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(current)) {
      if (!keys.includes(name)) {
        entry[name] = val;
      }
    }
    if (Object.keys(entry).length === Object.keys(current).length) {
      return false;
    }
    const nextData: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(data)) {
      if (name !== key) {
        nextData[name] = val;
      }
    }
    if (Object.keys(entry).length > 0) {
      nextData[key] = entry;
    }
    writeJsonAtomicSync(this.path, nextData);
    return true;
  }

  resolve(
    workspaceRoot: string,
    fallback: ModelSelection,
    options: { own?: boolean } = {},
  ): FolderSelection {
    const own = options.own !== false;
    const layers: [Record<string, string>, SelectionSourceKind][] = own
      ? [[this.get(workspaceRoot), "folder"]]
      : [];
    const main = mainRepository(workspaceRoot);
    if (main !== null) {
      layers.push([this.get(main), "main_repository"]);
    }
    const modelLayer = layers.find(([entry]) => Boolean(entry.model));
    const effortLayer = layers.find(([entry]) => Boolean(entry.reasoning_effort));
    return {
      selection: {
        provider_id: modelLayer ? modelLayer[0].provider : fallback.provider_id,
        model_id: modelLayer ? modelLayer[0].model : fallback.model_id,
        reasoning_effort: effortLayer ? effortLayer[0].reasoning_effort : fallback.reasoning_effort,
      },
      model_source: modelLayer ? modelLayer[1] : "settings",
      effort_source: effortLayer ? effortLayer[1] : "settings",
    };
  }

  private update(workspaceRoot: string, values: Record<string, string>): void {
    const data = this.read();
    const key = workspaceKey(workspaceRoot);
    const current = data[key] && typeof data[key] === "object" && !Array.isArray(data[key])
      ? (data[key] as Record<string, unknown>)
      : {};
    const nextData: Record<string, unknown> = {
      ...data,
      [key]: { ...current, ...values },
    };
    writeJsonAtomicSync(this.path, nextData);
  }

  private read(): Record<string, Record<string, unknown>> {
    if (!fs.existsSync(this.path)) {
      return {};
    }
    const raw = readJsonObject(this.path, "workspaces.json");
    const result: Record<string, Record<string, unknown>> = {};
    for (const [k, entry] of Object.entries(raw)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        result[k] = entry as Record<string, unknown>;
      }
    }
    return result;
  }
}
