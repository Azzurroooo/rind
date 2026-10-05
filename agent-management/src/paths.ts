import path from "node:path";
import os from "node:os";
import { realpath, stat, mkdir, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireValue } from "./model.js";

export function managementPaths(rindHome = process.env.RIND_HOME || path.join(os.homedir(), ".rind")) {
  const root = path.resolve(rindHome, "agents-management");
  const state = path.join(root, "state");
  const endpoint = process.platform === "win32"
    ? "\\\\.\\pipe\\rind-agents-" + createHash("sha256").update(state.toLowerCase()).digest("hex").slice(0, 24)
    : path.join(state, "service.sock");
  return { root, state, endpoint, token: path.join(state, "user-token"), manager: path.join(root, "manager"), workspaces: path.join(root, "workspaces"), artifacts: path.join(state, "artifacts") };
}
export type Paths = ReturnType<typeof managementPaths>;
export async function canonicalDirectory(value: string) {
  const root = await realpath(path.resolve(value));
  requireValue((await stat(root)).isDirectory(), "INVALID_WORKSPACE", "Workspace must be an existing directory.");
  return process.platform === "win32" ? root.toLowerCase() : root;
}
export function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
export async function privateDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(root, 0o700);
}
