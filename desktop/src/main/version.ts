import { readFileSync } from "node:fs"

export function readRindVersion(sourcePath: string | URL): string {
  const version = readFileSync(sourcePath, "utf8").match(/^__version__ = \"([^\"]+)\"$/m)?.[1]
  if (!version) throw new Error("Rind version is missing from agent/version.py.")
  return version
}
