import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function expandTilde(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export const expandUserPath = expandTilde;

export function canonicalizePath(targetPath: string): string {
  const expanded = expandTilde(targetPath) || targetPath;
  let current = path.resolve(expanded);
  const tail: string[] = [];
  for (let hops = 0; hops < 40; hops += 1) {
    try {
      const real = (realpathSync.native || realpathSync)(current);
      return path.join(real, ...tail);
    } catch {
      try {
        const linkTarget = readlinkSync(current);
        current = path.resolve(path.dirname(current), linkTarget);
        continue;
      } catch {}
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.join(current, ...tail);
}

export function normcasePath(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function resolveRindHome(envHome = process.env.RIND_HOME): string {
  const raw = String(envHome ?? process.env.RIND_HOME ?? "").trim();
  if (raw) return canonicalizePath(raw);
  return canonicalizePath(path.join(os.homedir(), ".rind"));
}

export function getDefaultSessionsDir(envHome?: string): string {
  return path.join(resolveRindHome(envHome), "sessions");
}

export function getDefaultSkillsDir(envHome?: string): string {
  return path.join(resolveRindHome(envHome), "skills");
}

export function validateSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string") {
    throw new Error("Invalid session_id: must be a string.");
  }
  const normalized = sessionId.trim();
  if (!normalized || normalized.includes("..") || !SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid session_id: ${JSON.stringify(sessionId)}`);
  }
  return normalized;
}

export function resolveSessionBase(sessionRoot?: string | null, sessionId?: string | null): string {
  const rootRaw = String(sessionRoot ?? "").trim();
  const rootResolved = rootRaw ? canonicalizePath(rootRaw) : getDefaultSessionsDir();
  if (!sessionId) {
    return rootResolved;
  }
  const cleanId = validateSessionId(sessionId);
  const candidate = canonicalizePath(path.join(rootResolved, cleanId));
  const rel = path.relative(rootResolved, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || path.dirname(candidate) !== rootResolved) {
    throw new Error(`Session path escapes session root: ${JSON.stringify(sessionId)}`);
  }
  return candidate;
}

export function normalizeWorkspaceRoot(workspaceRoot?: string | null): string {
  const raw = String(workspaceRoot ?? "").trim() || process.cwd();
  const resolved = canonicalizePath(raw);
  return normcasePath(resolved);
}

export const resolveProjectRoot = normalizeWorkspaceRoot;

export function validateWorkspaceRoot(workspaceRoot?: string | null): string {
  const raw = String(workspaceRoot ?? "").trim() || process.cwd();
  const resolved = canonicalizePath(raw);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`workspace_root does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`workspace_root must be a directory: ${resolved}`);
  }
  return normcasePath(resolved);
}

export function isGitRepository(workspaceRoot?: string | null): boolean {
  const target = workspaceRoot ? canonicalizePath(workspaceRoot) : process.cwd();
  let current = target;
  while (true) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export const SHELL_UNAVAILABLE_MESSAGE =
  "No supported shell backend was found. Install Git for Windows, set RIND_BASH_PATH to bash.exe, or enable PowerShell.";

export interface ShellDetection {
  readonly executable: string | null;
  readonly backend: string;
  readonly error?: string | null;
}

function findExecutableInPath(name: string): string | null {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name.endsWith(ext) ? name : name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

export function detectDefaultShell(): ShellDetection {
  if (process.platform !== "win32") {
    return {
      executable: findExecutableInPath("bash") || "bash",
      backend: "bash",
      error: null,
    };
  }
  const configured = String(process.env.RIND_BASH_PATH || "").trim();
  if (configured && existsSync(configured) && statSync(configured).isFile()) {
    return {
      executable: configured,
      backend: path.basename(configured).toLowerCase() === "sh.exe" ? "sh" : "bash",
      error: null,
    };
  }
  const appDir = path.dirname(process.execPath);
  const candidates = [
    path.join(appDir, "portable-git", "bin", "bash.exe"),
    path.join(appDir, "portable-git", "usr", "bin", "bash.exe"),
    path.join(appDir, "portable-git", "usr", "bin", "sh.exe"),
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/sh.exe",
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return {
          executable: candidate,
          backend: path.basename(candidate).toLowerCase() === "sh.exe" ? "sh" : "bash",
          error: null,
        };
      }
    } catch {}
  }
  const bashPath = findExecutableInPath("bash");
  if (bashPath) {
    return { executable: bashPath, backend: "bash", error: null };
  }
  for (const psName of ["pwsh", "powershell", "powershell.exe"]) {
    const psPath = findExecutableInPath(psName);
    if (psPath) return { executable: psPath, backend: "powershell", error: null };
  }
  const defaultPs = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (existsSync(defaultPs)) {
    return { executable: defaultPs, backend: "powershell", error: null };
  }
  return { executable: null, backend: "unavailable", error: SHELL_UNAVAILABLE_MESSAGE };
}

export function getSystemInfo(workspaceRoot?: string | null): string {
  const cwd = workspaceRoot ? path.resolve(expandTilde(workspaceRoot)) : process.cwd();
  const gitStatus = isGitRepository(cwd) ? "yes" : "no";
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const currentDate = `${yyyy}-${mm}-${dd}`;
  const osType =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "Darwin"
        : process.platform === "linux"
          ? "Linux"
          : os.type();
  const detection = detectDefaultShell();
  const shellTypeMap: Record<string, string> = {
    bash: "Bash",
    sh: "POSIX sh",
    powershell: "PowerShell",
    unavailable: "Unavailable",
  };
  const shellType = shellTypeMap[detection.backend] ?? detection.backend;
  const shellExecutable = detection.executable || "not found";
  return (
    "\n<environment_context>\n" +
    `Operating System: ${osType}\n` +
    `Current Date: ${currentDate}\n` +
    `Current Working Directory (Project Root): ${cwd}\n` +
    `Git Repository: ${gitStatus}\n` +
    `Shell Type: ${shellType}\n` +
    `Shell Executable: ${shellExecutable}\n` +
    "</environment_context>\n"
  );
}

export function checkPathAllowed(targetPath: string, allowedRoots: readonly string[]): string {
  const canonical = canonicalizePath(targetPath);
  const normCandidate = normcasePath(canonical);
  for (const root of allowedRoots) {
    const normRoot = normcasePath(canonicalizePath(root));
    if (normCandidate === normRoot) return canonical;
    const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
    if (normCandidate.startsWith(prefix)) return canonical;
  }
  throw new Error(`Path '${targetPath}' is outside allowed workspace roots.`);
}

export function isSymlinkEscape(rootPath: string, targetPath: string): boolean {
  const canonicalRoot = normcasePath(canonicalizePath(rootPath));
  const canonicalTarget = normcasePath(canonicalizePath(targetPath));
  if (canonicalTarget === canonicalRoot) return false;
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  if (!canonicalTarget.startsWith(prefix)) return true;
  try {
    const lst = lstatSync(targetPath);
    if (lst.isSymbolicLink()) {
      const real = normcasePath((realpathSync.native || realpathSync)(targetPath));
      if (real !== canonicalRoot && !real.startsWith(prefix)) return true;
    }
  } catch {}
  return false;
}
