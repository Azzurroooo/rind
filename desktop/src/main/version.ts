import { readFileSync } from "node:fs"

export function readRindVersion(sourcePath: string | URL): string {
  const version = readFileSync(sourcePath, "utf8").match(/RIND_VERSION\s*=\s*["']([^"']+)["']/m)?.[1]
  if (!version) throw new Error("Rind version is missing from runtime/src/version.ts.")
  return version
}
