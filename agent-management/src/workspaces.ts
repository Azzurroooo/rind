import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { requireValue, text } from "./model.js";
import { canonicalDirectory, inside } from "./paths.js";

const git = promisify(execFile);

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
  await git("git", ["check-ref-format", "--branch", branch], { cwd: repository });
  await git("git", ["rev-parse", "--verify", base + "^{commit}"], { cwd: repository });
  await git("git", ["worktree", "add", "-b", branch, target, base], { cwd: repository });
}

// Never forced: a worktree with uncommitted changes stays, and so does its branch.
export async function removeWorktree(repository: string, target: string) {
  const { stdout } = await git("git", ["status", "--porcelain"], { cwd: target });
  requireValue(!stdout.trim(), "WORKTREE_DIRTY", "This worktree has uncommitted changes. Have them committed first, or ask the user to remove it.");
  await git("git", ["worktree", "remove", target], { cwd: repository });
}
