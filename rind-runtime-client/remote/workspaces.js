import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const recentSessionLimit = 5;

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export async function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return asObject(parsed) || {};
  } catch {
    return {};
  }
}

export async function writeJsonObject(filePath, value, secret = false) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: secret ? 0o600 : 0o666,
    });
    if (secret && process.platform !== "win32") {
      await chmod(tempPath, 0o600).catch(() => {});
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeDriveRoot(raw) {
  const trimmed = String(raw || "").trim();
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  return trimmed;
}

export function storedPath(path) {
  return resolve(normalizeDriveRoot(path));
}

export function samePath(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = storedPath(left);
  const normalizedRight = storedPath(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function uniquePaths(paths) {
  const unique = [];
  for (const item of paths) {
    if (typeof item === "string" && item.trim() && !unique.some((existing) => samePath(existing, item))) {
      unique.push(storedPath(item));
    }
  }
  return unique;
}

export async function isDirectory(path) {
  if (!path) return false;
  try {
    return (await stat(normalizeDriveRoot(path))).isDirectory();
  } catch {
    return false;
  }
}

export async function canonicalDirectory(path) {
  const candidate = normalizeDriveRoot(path);
  if (!candidate) throw new Error("Choose a project folder.");
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new Error("The selected project folder does not exist.");
  }
  if (!info.isDirectory()) throw new Error("Choose a folder, not a file.");
  return realpath(candidate);
}

const INTERNAL_RIND_DIRS = [
  "runtime",
  "sessions",
  "agents",
  "teams",
  "management",
  "desktop",
  "agents-management",
];

function isPathInside(parentPath, childPath) {
  const parentNorm = storedPath(parentPath);
  const childNorm = storedPath(childPath);
  if (samePath(parentNorm, childNorm)) return true;
  const prefix =
    process.platform === "win32" || process.platform === "darwin"
      ? parentNorm.toLowerCase()
      : parentNorm;
  const candidate =
    process.platform === "win32" || process.platform === "darwin"
      ? childNorm.toLowerCase()
      : childNorm;
  return candidate.startsWith(`${prefix}\\`) || candidate.startsWith(`${prefix}/`);
}

export function isInternalRindPath(rindHome, targetPath) {
  if (!rindHome || !targetPath) return true;
  if (samePath(rindHome, targetPath)) return true;
  return INTERNAL_RIND_DIRS.some((sub) => isPathInside(join(rindHome, sub), targetPath));
}

function defaultDesktopConfigCandidates() {
  if (process.env.RIND_HOME?.trim()) return [];
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return [
      join(appData, "rind-desktop", "desktop-settings.json"),
      join(appData, "Rind", "desktop-settings.json"),
    ];
  }
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      join(support, "rind-desktop", "desktop-settings.json"),
      join(support, "Rind", "desktop-settings.json"),
    ];
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(configHome, "rind-desktop", "desktop-settings.json"),
    join(configHome, "Rind", "desktop-settings.json"),
  ];
}

function extractProjectsFromRaw(raw) {
  const rawProjects = Array.isArray(raw?.projects)
    ? raw.projects.filter((item) => typeof item === "string")
    : [];
  const legacyWorkspace = typeof raw?.workspace === "string" ? raw.workspace : "";
  const projects = uniquePaths([...rawProjects, legacyWorkspace].filter(Boolean));
  const requestedActive = typeof raw?.activeProjectPath === "string" ? raw.activeProjectPath : legacyWorkspace;
  const activeProjectPath = projects.find((p) => samePath(p, requestedActive)) || projects[0] || "";
  return { projects, activeProjectPath };
}

export function sharedWorkspacesPath(rindHome) {
  return join(rindHome, "projects.json");
}

export async function readSharedWorkspaces(rindHome, fallbackConfigFile = "") {
  const wsFile = sharedWorkspacesPath(rindHome);
  if (existsSync(wsFile)) {
    const raw = await readJsonObject(wsFile);
    if (Array.isArray(raw.projects)) {
      const { projects, activeProjectPath } = extractProjectsFromRaw(raw);
      return { projects, activeProjectPath, exists: true };
    }
  }
  const candidates = [
    ...(fallbackConfigFile ? [fallbackConfigFile] : []),
    ...defaultDesktopConfigCandidates(),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const raw = await readJsonObject(candidate);
    if (Array.isArray(raw.projects) || typeof raw.workspace === "string") {
      const { projects, activeProjectPath } = extractProjectsFromRaw(raw);
      return { projects, activeProjectPath, exists: false };
    }
  }
  return { projects: [], activeProjectPath: "", exists: false };
}

export async function writeSharedWorkspaces(rindHome, { projects = [], activeProjectPath = "" } = {}) {
  const normalizedProjects = uniquePaths(projects);
  const resolvedActive =
    normalizedProjects.find((p) => samePath(p, activeProjectPath)) || normalizedProjects[0] || "";
  await writeJsonObject(sharedWorkspacesPath(rindHome), {
    projects: normalizedProjects,
    activeProjectPath: resolvedActive,
  });
  return { projects: normalizedProjects, activeProjectPath: resolvedActive };
}

export async function registerSharedWorkspace(rindHome, workspacePath, { setActive = true } = {}) {
  if (!rindHome || !workspacePath || isInternalRindPath(rindHome, workspacePath)) {
    return readSharedWorkspaces(rindHome);
  }
  let canonical;
  try {
    canonical = await canonicalDirectory(workspacePath);
  } catch {
    return readSharedWorkspaces(rindHome);
  }
  if (isInternalRindPath(rindHome, canonical)) {
    return readSharedWorkspaces(rindHome);
  }
  const current = await readSharedWorkspaces(rindHome);
  const projects = uniquePaths([...current.projects, canonical]);
  const activeProjectPath =
    setActive || !current.activeProjectPath ? canonical : current.activeProjectPath;
  return writeSharedWorkspaces(rindHome, { projects, activeProjectPath });
}

export async function hasPersistedUserMessage(rindHome, sessionId) {
  try {
    const content = await readFile(join(rindHome, "sessions", sessionId, "messages.jsonl"), "utf8");
    return content
      .split(/\r?\n/)
      .some((line) => line.includes('"role"') && line.includes('"user"') && asObject(parseLine(line))?.role === "user");
  } catch {
    return false;
  }
}

function parseLine(line) {
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

export async function readSessionIndex(sessionIndexFile) {
  const index = await readJsonObject(sessionIndexFile);
  let rawEntries = [];
  if (Array.isArray(index.sessions)) {
    rawEntries = index.sessions;
  } else if (asObject(index.sessions)) {
    rawEntries = Object.entries(index.sessions).map(([id, value]) =>
      asObject(value) ? { id, ...value } : null,
    );
  }
  const sessions = rawEntries.flatMap((value) => {
    const session = asObject(value);
    if (!session) return [];
    const id = typeof session.id === "string" ? session.id : typeof session.session_id === "string" ? session.session_id : "";
    const workspaceRoot = typeof session.workspace_root === "string" ? session.workspace_root : "";
    if (!id || !workspaceRoot) return [];
    return [
      {
        id,
        title: typeof session.title === "string" ? session.title : typeof session.name === "string" ? session.name : "Untitled",
        preview: typeof session.preview === "string" ? session.preview : typeof session.last_user_message === "string" ? session.last_user_message : "",
        updatedAt: typeof session.updated_at === "string" ? session.updated_at : typeof session.created_at === "string" ? session.created_at : "",
        workspaceRoot: storedPath(workspaceRoot),
        hasUserMessage: session.has_user_message === true || Number(session.message_count) > 0,
        hasUserMessageMarker: typeof session.has_user_message === "boolean" || typeof session.message_count === "number",
      },
    ];
  });
  const rindHome = dirname(sessionIndexFile);
  const resolved = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      hasUserMessage: session.hasUserMessageMarker
        ? session.hasUserMessage
        : await hasPersistedUserMessage(rindHome, session.id),
    })),
  );
  return resolved.map(({ hasUserMessageMarker: _marker, ...session }) => session);
}

export async function projectSummaryForPath(path, sessions) {
  const available = await isDirectory(path);
  const projectSessions = sessions
    .filter((session) => session.hasUserMessage)
    .filter((session) => samePath(session.workspaceRoot, path))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    path,
    name: basename(path) || path,
    available,
    sessions: projectSessions.slice(0, recentSessionLimit),
    totalSessions: projectSessions.length,
  };
}

export async function listAvailableWorkspaces(
  rindHome,
  { fallbackConfigFile = "", isManagedWorkspacePath = async () => false } = {},
) {
  const [state, sessions] = await Promise.all([
    readSharedWorkspaces(rindHome, fallbackConfigFile),
    readSessionIndex(join(rindHome, "session_index.json")),
  ]);
  const projects = await Promise.all(
    state.projects.map(async (path) => {
      if (isInternalRindPath(rindHome, path) || (await isManagedWorkspacePath(path))) {
        return null;
      }
      return projectSummaryForPath(path, sessions);
    }),
  );
  const availableProjects = projects.filter((item) => item && item.available);
  const registeredWorkspaces = availableProjects.map((item) => item.path);
  return {
    availableProjects,
    registeredWorkspaces,
    activeProjectPath: state.activeProjectPath,
  };
}

const IGNORED_BROWSE_DIRS = new Set([
  "$recycle.bin",
  "system volume information",
  "recovery",
  "perflogs",
  "node_modules",
  "__pycache__",
]);

export async function listFilesystemRoots() {
  const home = homedir();
  const roots = [];
  if (process.platform === "win32") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const checks = await Promise.all(
      letters.map(async (letter) => {
        const drivePath = `${letter}:\\`;
        return (await isDirectory(drivePath)) ? { label: `${letter}:`, path: drivePath } : null;
      }),
    );
    for (const item of checks) {
      if (item) roots.push(item);
    }
  } else {
    roots.push({ label: "/", path: "/" });
  }
  if (home && (await isDirectory(home)) && !roots.some((r) => samePath(r.path, home))) {
    roots.push({ label: "Home", path: home });
  }
  return roots;
}

export async function browseWorkspaceDirectories(
  rindHome,
  requestedPath = "",
  { fallbackConfigFile = "", isManagedWorkspacePath = async () => false } = {},
) {
  let targetPath = String(requestedPath || "").trim();
  if (!targetPath) {
    const state = await readSharedWorkspaces(rindHome, fallbackConfigFile);
    if (state.activeProjectPath && (await isDirectory(state.activeProjectPath))) {
      targetPath = state.activeProjectPath;
    } else {
      targetPath = homedir() || process.cwd();
    }
  }
  const current = await canonicalDirectory(targetPath);
  const parentDir = dirname(current);
  const parent = samePath(parentDir, current) ? "" : parentDir;
  const [roots, rawEntries] = await Promise.all([
    listFilesystemRoots(),
    readdir(current, { withFileTypes: true }).catch(() => []),
  ]);

  const candidates = await Promise.all(
    rawEntries.map(async (entry) => {
      const name = String(entry?.name || "");
      if (!name || name.startsWith(".") || IGNORED_BROWSE_DIRS.has(name.toLowerCase())) {
        return null;
      }
      const fullPath = join(current, name);
      const isDir =
        entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(fullPath)));
      if (!isDir) return null;
      if (isInternalRindPath(rindHome, fullPath) || (await isManagedWorkspacePath(fullPath))) {
        return null;
      }
      return { name, path: fullPath };
    }),
  );

  const directories = candidates
    .filter(Boolean)
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
    );

  return {
    current,
    parent,
    roots,
    directories,
  };
}
