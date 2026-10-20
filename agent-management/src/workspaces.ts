import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { requireValue, text } from "./model.js";
import { canonicalDirectory, inside } from "./paths.js";

const execFileAsync = promisify(execFile);
const git = (args: string[], cwd: string) => execFileAsync("git", args, { cwd, timeout: 30_000, windowsHide: true });

// A new member's folder: a simple name directly under the team's creation root, never an existing path.
export async function newWorkspacePath(createRoot: string, name: unknown) {
  const clean = text(name, "Workspace name", 120);
  requireValue(/^[\p{L}\p{N}_.-]+$/u.test(clean) && clean !== "." && clean !== "..", "INVALID_PATH", "Choose a simple directory name without separators.");
  await mkdir(createRoot, { recursive: true });
  const root = await canonicalDirectory(createRoot);
  const target = path.join(root, clean);
  requireValue(inside(root, target) && target !== root, "INVALID_PATH", "Workspace must remain within the team's creation root.");
  try { await lstat(target); throw new Error("exists"); } catch (error) { requireValue((error as NodeJS.ErrnoException).code === "ENOENT", "PATH_EXISTS", "Target already exists; it will not be overwritten."); }
  return target;
}

export async function addWorktree(repository: string, target: string, branchName: unknown, baseRef: unknown) {
  const branch = text(branchName, "Branch", 200);
  const base = text(baseRef || "HEAD", "Base reference", 200);
  requireValue(!base.startsWith("-") && !branch.startsWith("-"), "INVALID_REF", "Git references cannot start with '-'.");
  await git(["check-ref-format", "--branch", branch], repository);
  await git(["rev-parse", "--verify", base + "^{commit}"], repository);
  await git(["worktree", "add", "-b", branch, target, base], repository);
}

// Never forced: a worktree with uncommitted changes stays, and so does its branch.
export async function removeWorktree(repository: string, target: string) {
  const { stdout } = await git(["status", "--porcelain"], target);
  requireValue(!stdout.trim(), "WORKTREE_DIRTY", "This worktree has uncommitted changes. Have them committed first, or ask the user to remove it.");
  await git(["worktree", "remove", target], repository);
}

export async function copyPreview(sourcePath: string) {
  const source = await canonicalDirectory(sourcePath);
  const files: string[] = []; const excluded: string[] = []; let bytes = 0;
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(source, absolute);
      if (entry.isSymbolicLink() || /^(?:\.git|\.rind|\.env(?:\..*)?|node_modules|\.venv|dist|build|.*\.(?:pem|key|p12|pfx))$/i.test(entry.name)) { excluded.push(relative); continue; }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) { files.push(relative); bytes += (await stat(absolute)).size; }
      requireValue(files.length < 10000 && bytes < 512 * 1024 * 1024, "COPY_TOO_LARGE", "Copy exceeds 10,000 files or 512 MiB. Prepare an independent directory manually.");
    }
  }
  await visit(source);
  files.sort(); excluded.sort();
  const fingerprint = createHash("sha256");
  for (const file of files) { fingerprint.update(file); fingerprint.update(await readFile(path.join(source, file))); }
  return { source, files, excluded, bytes, fingerprint: fingerprint.digest("hex") };
}
