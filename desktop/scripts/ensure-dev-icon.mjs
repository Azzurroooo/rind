import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function removeStaleDevStartMenuShortcut() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
  const staleShortcut = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Rind.lnk")
  if (!existsSync(staleShortcut)) return false
  try {
    rmSync(staleShortcut, { force: true })
    return true
  } catch {
    return false
  }
}

function refreshWindowsShellIconCache() {
  const sysRoot = process.env.SystemRoot || "C:\\Windows"
  const ie4uinit = join(sysRoot, "System32", "ie4uinit.exe")
  if (!existsSync(ie4uinit)) return
  try {
    execFileSync(ie4uinit, ["-show"], { stdio: "ignore", timeout: 4000 })
  } catch {
    // Non-fatal if shell icon cache refresh is unavailable.
  }
}

function main() {
  if (process.platform !== "win32") return

  const removedShortcut = removeStaleDevStartMenuShortcut()
  const icoPath = join(root, "resources", "icon.ico")
  const electronExeRaw = join(root, "node_modules", "electron", "dist", "electron.exe")
  const rceditExeRaw = join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe")

  if (!existsSync(icoPath) || !existsSync(electronExeRaw) || !existsSync(rceditExeRaw)) {
    if (removedShortcut) refreshWindowsShellIconCache()
    return
  }

  const electronExe = realpathSync(electronExeRaw)
  const rceditExe = realpathSync(rceditExeRaw)
  const stampFile = join(dirname(electronExe), ".rind-icon-stamp")

  try {
    const icoHash = createHash("sha256").update(readFileSync(icoPath)).digest("hex").slice(0, 16)
    if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === icoHash) {
      if (removedShortcut) refreshWindowsShellIconCache()
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
    refreshWindowsShellIconCache()
  } catch {
    if (removedShortcut) refreshWindowsShellIconCache()
  }
}

main()
