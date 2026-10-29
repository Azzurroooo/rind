import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
  skillToCatalogEntry,
  type LoadedSkill,
  type SkillMetadata,
} from "../domain/models.js";
import { resolveRindHome } from "./paths.js";

export const IMPORT_DEFAULTS: Readonly<Record<string, boolean>> = {
  claude_user: false,
  codex_user: false,
  claude_project: true,
  codex_project: true,
};

export const IMPORT_SOURCES = Object.keys(IMPORT_DEFAULTS) as readonly string[];

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SKILLS_DIR = path.resolve(CURRENT_DIR, "..", "..", "skills");
export const SYSTEM_SKILLS = ".system";
export const BUNDLE_MARKER = ".bundle";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function splitFrontmatter(text: string): [string, string] {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.match(/[^\r\n]*(\r\n|\n|\r)|[^\r\n]+/g) || [];
  if (lines.length === 0 || (lines[0] ?? "").trim() !== "---") {
    throw new Error("SKILL.md must start with --- frontmatter.");
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      return [
        lines.slice(1, index).join(""),
        lines.slice(index + 1).join("").trim(),
      ];
    }
  }
  throw new Error("SKILL.md frontmatter is missing its closing ---.");
}

function unquoteScalar(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
    if (value[0] === '"') {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function loadFrontmatter(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let blockMode: "|" | ">" | null = null;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (currentKey !== null && blockMode !== null) {
      fields[currentKey] = blockMode === ">"
        ? blockLines.map(l => l.trim()).join(" ").trim()
        : blockLines.join("\n").trim();
    }
    blockMode = null;
    blockLines = [];
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#")) {
      if (blockMode !== null) {
        blockLines.push("");
      }
      continue;
    }
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && currentKey !== null) {
      if (blockMode !== null) {
        blockLines.push(stripped);
      } else {
        const prev = typeof fields[currentKey] === "string" ? (fields[currentKey] as string) : "";
        fields[currentKey] = `${prev} ${stripped}`.trim();
      }
      continue;
    }
    flushBlock();
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx <= 0) {
      throw new Error("frontmatter must be a mapping.");
    }
    const key = rawLine.slice(0, colonIdx).trim();
    const rawValue = rawLine.slice(colonIdx + 1).trim();
    if (!key || /[\s[\]{}]/.test(key)) {
      throw new Error("invalid YAML frontmatter: ParserError.");
    }
    currentKey = key;
    if (rawValue === "|" || rawValue === "|-") {
      blockMode = "|";
      fields[key] = "";
    } else if (rawValue === ">" || rawValue === ">-") {
      blockMode = ">";
      fields[key] = "";
    } else if (rawValue === "true") {
      fields[key] = true;
    } else if (rawValue === "false") {
      fields[key] = false;
    } else if (rawValue === "null" || rawValue === "~" || rawValue === "") {
      fields[key] = null;
    } else {
      if ((rawValue.startsWith('"') && !rawValue.endsWith('"')) || (rawValue.startsWith("'") && !rawValue.endsWith("'"))) {
        throw new Error("invalid YAML frontmatter: ScannerError.");
      }
      fields[key] = unquoteScalar(rawValue);
    }
  }
  flushBlock();
  return fields;
}

export function parseSkillMetadata(
  text: string,
  location: string,
  folderName: string,
  source: string,
): [SkillMetadata, string | null] {
  const [raw] = splitFrontmatter(text);
  const fields = loadFrontmatter(raw);
  const rawName = fields.name !== undefined && fields.name !== null ? fields.name : folderName;
  if (typeof rawName !== "string" || !SKILL_NAME_PATTERN.test(rawName.trim())) {
    throw new Error(`invalid name ${JSON.stringify(rawName)}; use letters, digits, hyphens and underscores.`);
  }
  const name = rawName.trim();
  const rawDesc = fields.description;
  const description = typeof rawDesc === "string" ? rawDesc.trim().split(/\s+/).filter(Boolean).join(" ") : "";
  if (!description) {
    throw new Error("missing description.");
  }
  const metadata: SkillMetadata = {
    name,
    description,
    location,
    source,
    model_invocable: fields["disable-model-invocation"] !== true,
  };
  const warning = name !== folderName ? `name '${name}' differs from its folder '${folderName}'.` : null;
  return [metadata, warning];
}

export function renderSkillContent(skill: LoadedSkill): string {
  const metadata = skill.metadata;
  return `<skill_content name="${escapeHtml(metadata.name)}" location="${escapeHtml(metadata.location)}">\n${skill.body}\n</skill_content>`;
}

function renderCatalogLine(item: { name: string; location: string }, description: string): string {
  return `<skill name="${escapeHtml(item.name)}" location="${escapeHtml(item.location)}">${description}</skill>`;
}

function escapedPrefix(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = escapeHtml(text.slice(0, midpoint));
    if (candidate.length <= maxChars) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function renderAvailableSkills(
  entries: readonly { name: string; description: string; location: string }[],
  maxChars: number = 8000,
): string {
  const normalized = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (normalized.length === 0) {
    return "";
  }
  const intro =
    "<available_skills>\n" +
    "Skills are specialized instructions in SKILL.md files. When a task matches a skill's description, " +
    "read its file with read_file before acting. Resolve relative paths in a skill against the directory " +
    "that contains its SKILL.md.";
  const footer = "</available_skills>";
  const budget = Math.max(0, Math.trunc(maxChars));
  if (`${intro}\n${footer}`.length > budget) {
    return "";
  }

  for (let count = normalized.length; count >= 0; count -= 1) {
    const omitted = normalized.length - count;
    const selected = normalized.slice(0, count);
    const lines = selected.map(item => renderCatalogLine(item, ""));
    if (omitted > 0) {
      lines.push(`${omitted} additional Skill(s) omitted due to catalog budget.`);
    }
    const skeleton = [intro, ...lines, footer].join("\n");
    if (skeleton.length > budget) {
      continue;
    }
    let descriptionBudget = budget - skeleton.length;
    const rendered: string[] = [];
    let remaining = selected.length;
    for (const item of selected) {
      const share = remaining > 0 ? Math.floor(descriptionBudget / remaining) : 0;
      const renderedDescription = escapedPrefix(item.description, share);
      rendered.push(renderCatalogLine(item, renderedDescription));
      descriptionBudget -= renderedDescription.length;
      remaining -= 1;
    }
    if (omitted > 0) {
      rendered.push(`${omitted} additional Skill(s) omitted due to catalog budget.`);
    }
    return [intro, ...rendered, footer].join("\n");
  }
  return "";
}

export interface SkillSource {
  readonly id: string;
  readonly label: string;
  readonly paths: readonly string[];
}

export interface SkillProblem {
  readonly location: string;
  readonly message: string;
}

export interface ScannedSource {
  readonly source: SkillSource;
  readonly enabled: boolean;
  readonly skills: readonly SkillMetadata[];
  readonly problems: readonly SkillProblem[];
}

export class SkillScan {
  readonly sources: readonly ScannedSource[];

  constructor(sources: readonly ScannedSource[]) {
    this.sources = sources;
  }

  effective(): Map<string, SkillMetadata> {
    const skills = new Map<string, SkillMetadata>();
    for (const scanned of this.sources) {
      if (scanned.enabled) {
        for (const skill of scanned.skills) {
          skills.set(skill.name.toLowerCase(), skill);
        }
      }
    }
    return skills;
  }
}

function findSkillFiles(dirOrFile: string): string[] {
  if (path.basename(dirOrFile) === "SKILL.md") {
    return [dirOrFile];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirOrFile, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const result: string[] = [];
  for (const child of entries) {
    if (child.name.startsWith(".")) continue;
    const skillFile = path.join(dirOrFile, child.name, "SKILL.md");
    try {
      if (fs.statSync(skillFile).isFile()) {
        result.push(skillFile);
      }
    } catch {
      // ignore
    }
  }
  return result;
}

function scanSource(source: SkillSource): [readonly SkillMetadata[], readonly SkillProblem[]] {
  const skills: SkillMetadata[] = [];
  const problems: SkillProblem[] = [];
  for (const sourcePath of source.paths) {
    for (const file of findSkillFiles(sourcePath)) {
      try {
        const text = fs.readFileSync(file, "utf8");
        const resolved = fs.realpathSync(file);
        const [metadata, warning] = parseSkillMetadata(
          text,
          resolved,
          path.basename(path.dirname(file)),
          source.id,
        );
        skills.push(metadata);
        if (warning) {
          problems.push({ location: file, message: warning });
        }
      } catch (err) {
        problems.push({ location: file, message: (err as Error).message });
      }
    }
  }
  if (source.id === "builtin" && skills.length === 0 && problems.length === 0) {
    problems.push({
      location: source.paths[0],
      message: "built-in skills are missing; restart Rind or reinstall it.",
    });
  }
  return [skills, problems];
}

export class SkillRepository {
  private readonly sources: readonly SkillSource[];

  constructor(
    workspace: string,
    options?: {
      home?: string | null;
      rindHome?: string | null;
      skillFiles?: readonly string[];
    },
  ) {
    const project = path.resolve(workspace);
    const user = options?.home ? path.resolve(options.home) : os.homedir();
    const rind = options?.rindHome ? path.resolve(options.rindHome) : resolveRindHome();
    const skillFiles = (options?.skillFiles ?? []).map(f => path.resolve(f));
    this.sources = [
      { id: "builtin", label: "Rind · built-in", paths: [path.join(rind, "skills", SYSTEM_SKILLS)] },
      { id: "claude_user", label: "Claude · user", paths: [path.join(user, ".claude", "skills")] },
      { id: "codex_user", label: "Codex · user", paths: [path.join(user, ".codex", "skills"), path.join(user, ".agents", "skills")] },
      { id: "rind_user", label: "Rind · user", paths: [path.join(rind, "skills")] },
      { id: "claude_project", label: "Claude · project", paths: [path.join(project, ".claude", "skills")] },
      { id: "codex_project", label: "Codex · project", paths: [path.join(project, ".codex", "skills"), path.join(project, ".agents", "skills")] },
      { id: "rind_project", label: "Rind · project", paths: [path.join(project, ".rind", "skills")] },
      { id: "agent", label: "Team", paths: skillFiles },
    ];
  }

  scan(imports: Readonly<Record<string, boolean>> = {}): SkillScan {
    return new SkillScan(
      this.sources.map(source => {
        const enabled = source.id in imports
          ? Boolean(imports[source.id])
          : (IMPORT_DEFAULTS[source.id] ?? true);
        const [skills, problems] = scanSource(source);
        return { source, enabled, skills, problems };
      }),
    );
  }

  listSkills(imports: Readonly<Record<string, boolean>> = {}): SkillMetadata[] {
    return Array.from(this.scan(imports).effective().values()).sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }

  loadSkill(name: string, imports: Readonly<Record<string, boolean>> = {}): LoadedSkill | null {
    const clean = String(name || "").trim().toLowerCase();
    const metadata = this.scan(imports).effective().get(clean);
    if (!metadata) {
      return null;
    }
    const raw = fs.readFileSync(metadata.location, "utf8");
    const [, body] = splitFrontmatter(raw);
    return { metadata, body };
  }
}

function fingerprintDir(root: string): string {
  const digest = createHash("sha256");
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(root);
  files.sort();
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    digest.update(Buffer.from(`${rel}\0`, "utf8"));
    digest.update(fs.readFileSync(file));
    digest.update(Buffer.from("\0", "utf8"));
  }
  return digest.digest("hex");
}

function installedFingerprint(target: string): string {
  try {
    return fs.readFileSync(path.join(target, BUNDLE_MARKER), "utf8");
  } catch {
    return "";
  }
}

function copyDirRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function installSystemSkills(
  rindHome: string,
  bundled: string = BUNDLED_SKILLS_DIR,
): void {
  const skillsDir = path.join(path.resolve(rindHome), "skills");
  const target = path.join(skillsDir, SYSTEM_SKILLS);
  const fp = fingerprintDir(bundled);
  if (installedFingerprint(target) === fp) {
    return;
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  const staged = path.join(skillsDir, `${SYSTEM_SKILLS}-${randomUUID().replace(/-/g, "")}`);
  copyDirRecursive(bundled, staged);
  fs.writeFileSync(path.join(staged, BUNDLE_MARKER), fp, "utf8");
  if (fs.existsSync(target)) {
    const retired = path.join(skillsDir, `${SYSTEM_SKILLS}-retired-${randomUUID().replace(/-/g, "")}`);
    fs.renameSync(target, retired);
  }
  fs.renameSync(staged, target);
  for (const name of fs.readdirSync(skillsDir)) {
    if (name.startsWith(`${SYSTEM_SKILLS}-`)) {
      fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
    }
  }
}

const DOLLAR_MENTION_PATTERN = /\$([A-Za-z0-9_-]+)/g;
const SLASH_PREFIX_PATTERN = /^\s*\/skill:([A-Za-z0-9_-]+)(?=\s|$)/i;

export interface SkillInvocation {
  readonly name: string;
  readonly syntax: "slash" | "dollar";
}

export class SkillInvocationParser {
  parse(userMessage: string): SkillInvocation[] {
    if (typeof userMessage !== "string" || !userMessage) {
      return [];
    }
    const invocations: SkillInvocation[] = [];
    const seen = new Set<string>();
    const slashMatch = SLASH_PREFIX_PATTERN.exec(userMessage);
    if (slashMatch) {
      const name = slashMatch[1];
      const key = name.toLowerCase();
      seen.add(key);
      invocations.push({ name, syntax: "slash" });
    }
    for (const match of userMessage.matchAll(DOLLAR_MENTION_PATTERN)) {
      const name = match[1];
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      invocations.push({ name, syntax: "dollar" });
    }
    return invocations;
  }
}

export interface SkillSessionPort {
  getSkillSources(): Promise<Record<string, boolean>>;
  setSkillCatalog(entries: { name: string; description: string; location: string }[]): Promise<void>;
  persistUserInput(content: string, options?: { meta?: Record<string, unknown> }): Promise<void>;
  persistMessage(
    role: string,
    content: string,
    toolCallId?: string | null,
    toolName?: string | null,
    meta?: Record<string, unknown> | null,
    reasoningContent?: string | null,
    attachments?: unknown[] | null,
  ): Promise<void>;
}

export class SkillTurnCoordinator {
  private readonly repository: SkillRepository;
  private readonly catalog: boolean;
  private readonly parser = new SkillInvocationParser();

  constructor(repository: SkillRepository, options: { catalog: boolean }) {
    this.repository = repository;
    this.catalog = options.catalog;
  }

  async persistUserInput(session: SkillSessionPort, text: string): Promise<SkillInvocation[]> {
    const invocations = this.parser.parse(text);
    const imports = invocations.length > 0 ? await session.getSkillSources() : {};
    const loaded: [SkillInvocation, LoadedSkill][] = [];
    for (const invocation of invocations) {
      const skill = this.repository.loadSkill(invocation.name, imports);
      if (!skill) {
        if (invocation.syntax === "slash") {
          throw new Error(`Unknown Skill: ${invocation.name}`);
        }
        continue;
      }
      loaded.push([invocation, skill]);
    }
    if (loaded.length > 0) {
      await session.persistUserInput(text, {
        meta: {
          kind: "user_prompt",
          skill_invocations: loaded.map(([inv, s]) => ({
            name: s.metadata.name,
            syntax: inv.syntax,
          })),
        },
      });
    } else {
      await session.persistUserInput(text);
    }
    for (const [invocation, skill] of loaded) {
      await session.persistMessage(
        "user",
        renderSkillContent(skill),
        null,
        null,
        {
          kind: "skill_snapshot",
          name: skill.metadata.name,
          location: skill.metadata.location,
          syntax: invocation.syntax,
        },
      );
    }
    return loaded.map(([inv]) => inv);
  }

  async syncCatalog(session: SkillSessionPort): Promise<void> {
    let entries: { name: string; description: string; location: string }[] = [];
    try {
      const skills = this.catalog
        ? this.repository.listSkills(await session.getSkillSources())
        : [];
      entries = skills.filter(s => s.model_invocable).map(skillToCatalogEntry);
    } catch {
      return;
    }
    try {
      await session.setSkillCatalog(entries);
    } catch {
      // ignore
    }
  }
}
