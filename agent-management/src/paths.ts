import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireValue } from "./model.js";
import { privateDirectory, resolveRindHome } from "../../rind-runtime-client/local-files.js";

export function managementPaths(rindHome = process.env.RIND_HOME) {
  const root = path.join(resolveRindHome(rindHome), "agents-management");
  const state = path.join(root, "state");
  const endpoint = process.platform === "win32"
    ? "\\\\.\\pipe\\rind-agents-" + createHash("sha256").update(state.toLowerCase()).digest("hex").slice(0, 24)
    : path.join(state, "service.sock");
  return { root, state, endpoint, token: path.join(state, "user-token"), record: path.join(state, "service.json"), manager: path.join(root, "manager"), workspaces: path.join(root, "workspaces"), artifacts: path.join(state, "artifacts") };
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
export { privateDirectory, resolveRindHome };
