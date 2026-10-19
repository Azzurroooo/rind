import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function main() {
  if (process.platform !== "win32") return

  const icoPath = join(root, "resources", "icon.ico")
  const electronExe = join(root, "node_modules", "electron", "dist", "electron.exe")
  const rceditExe = join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe")
  const stampFile = join(root, "node_modules", "electron", "dist", ".rind-icon-stamp")

  if (!existsSync(icoPath) || !existsSync(electronExe) || !existsSync(rceditExe)) {
    return
  }

  try {
    const icoHash = createHash("sha256").update(readFileSync(icoPath)).digest("hex").slice(0, 16)
    if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === icoHash) {
      return
    }
    execFileSync(
      rceditExe,
      [
        electronExe,
        "--set-icon",
        icoPath,
        "--set-version-string",
        "ProductName",
        "Rind",
        "--set-version-string",
        "FileDescription",
        "Rind",
      ],
      { stdio: "ignore" },
    )
    writeFileSync(stampFile, icoHash, "utf8")
  } catch {
    // Ignore if electron.exe is currently locked by a running instance.
  }
}

main()
