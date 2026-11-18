import fs from "node:fs";
import path from "node:path";

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const INT_PATTERN = /^-?\d+$/;

export const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "worker",
  "workspace",
  "worker_token",
  "channels",
  "pairing",
  "cooldown_per_minute",
  "uploads_dir",
]);

export const KNOWN_PAIRING_KEYS: ReadonlySet<string> = new Set(["enabled", "ttl_minutes"]);
export const KNOWN_CHANNEL_KEYS: ReadonlySet<string> = new Set([
  "token",
  "allow_from",
  "group_allow",
]);

export const CHANNEL_EXTRA_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  telegram: new Set(["proxy"]),
  discord: new Set<string>(),
  wecom: new Set([
    "corp_id",
    "agent_id",
    "secret",
    "encoding_aes_key",
    "callback_host",
    "callback_port",
  ]),
  whatsapp: new Set([
    "phone_number_id",
    "access_token",
    "verify_token",
    "webhook_host",
    "webhook_port",
  ]),
  email: new Set([
    "imap_host",
    "imap_port",
    "imap_ssl",
    "smtp_host",
    "smtp_port",
    "smtp_starttls",
    "username",
    "password",
    "mailbox",
    "poll_interval",
  ]),
  slack: new Set(["app_token", "bot_token"]),
  qq: new Set(["ws_path", "ws_port", "access_token"]),
  feishu: new Set(["app_id", "app_secret"]),
  dingtalk: new Set(["client_id", "client_secret"]),
};

const CHANNEL_PORT_KEYS: ReadonlySet<string> = new Set([
  "callback_port",
  "webhook_port",
  "ws_port",
  "imap_port",
  "smtp_port",
]);
const CHANNEL_BOOL_KEYS: ReadonlySet<string> = new Set(["imap_ssl", "smtp_starttls"]);
const CHANNEL_INT_KEYS: ReadonlySet<string> = new Set(["poll_interval"]);
const CHANNEL_SCALAR_KEYS: ReadonlySet<string> = new Set(["agent_id", "phone_number_id"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface PairingConfig {
  readonly enabled: boolean;
  readonly ttl_minutes: number;
}

export interface ChannelConfig {
  readonly id: string;
  readonly token: string;
  readonly allow_from: readonly string[];
  readonly group_allow: readonly string[];
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface GatewayConfig {
  readonly worker: string;
  readonly workspace: string;
  readonly worker_token: string | null;
  readonly channels: Readonly<Record<string, ChannelConfig>>;
  readonly pairing: PairingConfig;
  readonly cooldown_per_minute: number;
  readonly uploads_dir: string;
}

export function resolveConfigPath(explicit: string | null | undefined, workspace: string): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!isFile(resolved)) {
      throw new ConfigError(`gateway config file not found: ${explicit}`);
    }
    return explicit;
  }
  const candidate = path.join(workspace, ".rind", "gateway.yaml");
  if (!isFile(candidate)) {
    throw new ConfigError(
      `gateway config file not found: ${candidate} (use --config to point at one)`,
    );
  }
  return candidate;
}

export function loadConfig(
  filePath: string,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): GatewayConfig {
  const text = fs.readFileSync(filePath, "utf8");
  const env = options?.env ?? process.env;
  const data = parseYaml(text, { env });
  return buildConfig(data);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isAbsoluteAnyPlatform(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || path.posix.isAbsolute(p);
}

// --- YAML subset parser ------------------------------------------------------

export function parseYaml(
  text: string,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): Record<string, unknown> {
  const env = options?.env ?? process.env;
  const lines = significantLines(text);
  if (lines.length === 0) {
    return {};
  }
  const [value, index] = parseMapping(lines, 0, lines[0]![0], env);
  if (index !== lines.length) {
    const [indent] = lines[index]!;
    throw new ConfigError(
      `gateway config line ${index + 1}: unexpected indentation (indent ${indent})`,
    );
  }
  return value;
}

function significantLines(text: string): Array<[number, string]> {
  const lines: Array<[number, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const leadingLen = raw.length - raw.trimStart().length;
    if (raw.slice(0, leadingLen).includes("\t")) {
      throw new ConfigError("gateway config: tab indentation is not supported");
    }
    const stripped = stripComment(raw).trimEnd();
    if (!stripped.trim()) {
      continue;
    }
    const spaceIndent = stripped.length - stripped.replace(/^ +/, "").length;
    lines.push([spaceIndent, stripped.trim()]);
  }
  return lines;
}

function stripComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || line[index - 1] === " " || line[index - 1] === "\t")) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseMapping(
  lines: ReadonlyArray<[number, string]>,
  startIndex: number,
  indent: number,
  env: Readonly<Record<string, string | undefined>>,
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let index = startIndex;
  while (index < lines.length) {
    const [lineIndent, content] = lines[index]!;
    if (lineIndent < indent) {
      break;
    }
    if (lineIndent > indent) {
      throw new ConfigError(
        `gateway config line ${index + 1}: unexpected indentation (indent ${lineIndent})`,
      );
    }
    const colonIdx = content.indexOf(":");
    const key = colonIdx === -1 ? "" : content.slice(0, colonIdx).trim();
    if (colonIdx === -1 || !key) {
      throw new ConfigError(`gateway config line ${index + 1}: expected 'key: value'`);
    }
    const rest = content.slice(colonIdx + 1).trim();
    index += 1;
    if (rest) {
      result[key] = parseValue(rest, env);
    } else if (index < lines.length && lines[index]![0] > indent) {
      const [child, nextIdx] = parseMapping(lines, index, lines[index]![0], env);
      result[key] = child;
      index = nextIdx;
    } else {
      result[key] = {};
    }
  }
  return [result, index];
}

function parseValue(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): unknown {
  const interpolated = interpolate(raw, env);
  if (interpolated.startsWith("[") && interpolated.endsWith("]")) {
    return parseInlineList(interpolated, env);
  }
  return parseScalar(interpolated, env);
}

function interpolate(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return raw.replace(VAR_PATTERN, (_match, name: string) => {
    const val = env[name];
    if (val === undefined) {
      throw new ConfigError(`gateway config: undefined environment variable: ${name}`);
    }
    return val;
  });
}

function splitItems(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "[") {
      depth += 1;
      current += char;
    } else if (char === "]") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    items.push(current);
  }
  return items;
}

function parseInlineList(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): Array<string | boolean | number> {
  const body = raw.slice(1, -1).trim();
  if (!body) {
    return [];
  }
  return splitItems(body).map(item => parseScalar(item.trim(), env));
}

function parseScalar(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string | boolean | number {
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return String(parsed);
    } catch {
      throw new ConfigError(`gateway config: invalid double-quoted string: ${raw}`);
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      throw new ConfigError(`gateway config: invalid single-quoted string: ${raw}`);
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  if (INT_PATTERN.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return interpolate(raw, env);
}

// --- YAML rendering (wizard/doctor write path) --------------------------------

const YAML_SPECIAL_CHARS = ":#{}[]&*!|>%@`";

function renderScalar(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  const text = String(value);
  if (text.includes("'")) {
    const escaped = text.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  const hasSpecial = [...text].some(ch => YAML_SPECIAL_CHARS.includes(ch));
  if (
    text === "" ||
    INT_PATTERN.test(text) ||
    text === "true" ||
    text === "false" ||
    hasSpecial ||
    text !== text.trim() ||
    text.startsWith("$")
  ) {
    return `'${text}'`;
  }
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function renderMapping(data: Readonly<Record<string, unknown>>, indent: number): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        continue;
      }
      lines.push(`${pad}${key}:`);
      lines.push(renderMapping(value, indent + 1));
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      const items = value.map(item => renderScalar(item)).join(", ");
      lines.push(`${pad}${key}: [${items}]`);
    } else if (value === null || value === undefined) {
      continue;
    } else {
      lines.push(`${pad}${key}: ${renderScalar(value)}`);
    }
  }
  return lines.join("\n");
}

export function renderYaml(data: Readonly<Record<string, unknown>>): string {
  if (!data || Object.keys(data).length === 0) {
    return "";
  }
  return `${renderMapping(data, 0)}\n`;
}

// --- schema validation -------------------------------------------------------

export function buildConfig(data: Readonly<Record<string, unknown>>): GatewayConfig {
  checkKeys(data, KNOWN_TOP_LEVEL_KEYS, "");
  const worker = requireStr(data, "worker");
  if (worker !== "stdio" && !worker.startsWith("ws://") && !worker.startsWith("wss://")) {
    throw new ConfigError('gateway config: worker must be "stdio" or a ws:// (wss://) URL');
  }
  const workspace = requireStr(data, "workspace");
  if (!isAbsoluteAnyPlatform(workspace)) {
    throw new ConfigError("gateway config: workspace must be an absolute path");
  }
  const workerTokenRaw = data.worker_token;
  if (workerTokenRaw !== undefined && workerTokenRaw !== null && typeof workerTokenRaw !== "string") {
    throw new ConfigError("gateway config: worker_token must be a string");
  }
  const rawPairing = data.pairing ?? {};
  if (!isPlainObject(rawPairing)) {
    throw new ConfigError("gateway config: pairing must be a mapping");
  }
  const pairing = buildPairing(rawPairing);
  const cooldown = buildCooldown(data.cooldown_per_minute);
  const uploadsDir = data.uploads_dir === undefined ? "uploads" : data.uploads_dir;
  if (typeof uploadsDir !== "string" || !uploadsDir || isAbsoluteAnyPlatform(uploadsDir)) {
    throw new ConfigError("gateway config: uploads_dir must be a workspace-relative path");
  }
  const rawChannels = data.channels ?? {};
  if (!isPlainObject(rawChannels)) {
    throw new ConfigError("gateway config: channels must be a mapping");
  }
  return {
    worker,
    workspace,
    worker_token: typeof workerTokenRaw === "string" && workerTokenRaw ? workerTokenRaw : null,
    channels: buildChannels(rawChannels),
    pairing,
    cooldown_per_minute: cooldown,
    uploads_dir: uploadsDir,
  };
}

function buildPairing(raw: Readonly<Record<string, unknown>>): PairingConfig {
  checkKeys(raw, KNOWN_PAIRING_KEYS, "pairing");
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") {
    throw new ConfigError("gateway config: pairing.enabled must be true or false");
  }
  const ttlMinutes = raw.ttl_minutes === undefined ? 60 : raw.ttl_minutes;
  if (
    typeof ttlMinutes !== "number" ||
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > 10080
  ) {
    throw new ConfigError("gateway config: pairing.ttl_minutes must be an integer in [1, 10080]");
  }
  return { enabled, ttl_minutes: ttlMinutes };
}

function buildCooldown(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return 10;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10000) {
    throw new ConfigError(
      "gateway config: cooldown_per_minute must be an integer in [1, 10000]",
    );
  }
  return raw;
}

function buildChannels(
  raw: Readonly<Record<string, unknown>>,
): Record<string, ChannelConfig> {
  const channels: Record<string, ChannelConfig> = {};
  for (const [channelId, block] of Object.entries(raw)) {
    if (!isPlainObject(block)) {
      throw new ConfigError(`gateway config: channels.${channelId} must be a mapping`);
    }
    const cid = String(channelId);
    const allowed = new Set<string>([
      ...KNOWN_CHANNEL_KEYS,
      ...(CHANNEL_EXTRA_KEYS[cid] ?? []),
    ]);
    checkKeys(block, allowed, `channels.${cid}`);
    const allowFrom = stringList(block.allow_from ?? [], `channels.${cid}.allow_from`);
    const groupAllow = stringList(block.group_allow ?? [], `channels.${cid}.group_allow`);
    const tokenRaw = block.token;
    if (tokenRaw !== undefined && tokenRaw !== null && typeof tokenRaw !== "string") {
      throw new ConfigError(`gateway config: channels.${cid}.token must be a string`);
    }
    const token = typeof tokenRaw === "string" ? tokenRaw : "";
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block)) {
      if (!KNOWN_CHANNEL_KEYS.has(key)) {
        extra[key] = validateChannelValue(cid, key, value);
      }
    }
    channels[cid] = {
      id: cid,
      token,
      allow_from: allowFrom,
      group_allow: groupAllow,
      extra,
    };
  }
  return channels;
}

function validateChannelValue(channelId: string, key: string, raw: unknown): unknown {
  const label = `gateway config: channels.${channelId}.${key}`;
  if (CHANNEL_BOOL_KEYS.has(key)) {
    if (typeof raw !== "boolean") {
      throw new ConfigError(`${label} must be true or false`);
    }
    return raw;
  }
  if (CHANNEL_PORT_KEYS.has(key)) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
      throw new ConfigError(`${label} must be an integer port in [1, 65535]`);
    }
    return raw;
  }
  if (CHANNEL_INT_KEYS.has(key)) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 5 || raw > 3600) {
      throw new ConfigError(`${label} must be an integer seconds value in [5, 3600]`);
    }
    return raw;
  }
  if (CHANNEL_SCALAR_KEYS.has(key)) {
    if (typeof raw === "number" && Number.isInteger(raw)) {
      return String(raw);
    }
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
    throw new ConfigError(`${label} must be a non-empty string or integer`);
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return raw.trim();
}

function stringList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError(`gateway config: ${label} must be a list of strings`);
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new ConfigError(`gateway config: ${label} must contain only strings`);
    }
  }
  return [...raw];
}

function requireStr(data: Readonly<Record<string, unknown>>, key: string): string {
  const value = data[key];
  if (value === undefined || value === null) {
    throw new ConfigError(`gateway config: missing required key: ${key}`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`gateway config: ${key} must be a non-empty string`);
  }
  return value.trim();
}

function checkKeys(
  raw: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      const prefix = label ? `${label}.` : "";
      throw new ConfigError(`gateway config: unknown key: ${prefix}${key}`);
    }
  }
}
