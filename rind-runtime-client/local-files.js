import os from "node:os";
import { mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function privateDirectory(directory) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  else if (created) {
    const user = [process.env.USERDOMAIN, os.userInfo().username].filter(Boolean).join("\\");
    await promisify(execFile)("icacls.exe", [directory, "/inheritance:r", "/grant:r", user + ":(OI)(CI)F"], { windowsHide: true });
  }
}
