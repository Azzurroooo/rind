import os from "node:os";
import path from "node:path";
import { readlinkSync, realpathSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function resolveRindHome(home = process.env.RIND_HOME) {
  const raw = String(home ?? process.env.RIND_HOME ?? "").trim();
  const expanded = !raw ? path.join(os.homedir(), ".rind")
    : raw === "~" ? os.homedir()
    : raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(2))
    : raw;
  let current = path.resolve(expanded);
  const tail = [];
  for (let hops = 0; hops < 40; hops++) {
    try {
      return path.join((realpathSync.native || realpathSync)(current), ...tail);
    } catch {
      try {
        current = path.resolve(path.dirname(current), readlinkSync(current));
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

export async function privateDirectory(directory) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  else if (created) {
    const user = [process.env.USERDOMAIN, os.userInfo().username].filter(Boolean).join("\\");
    await promisify(execFile)("icacls.exe", [directory, "/inheritance:r", "/grant:r", user + ":(OI)(CI)F"], { windowsHide: true });
  }
}
