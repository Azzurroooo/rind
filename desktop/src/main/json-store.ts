import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value = asObject(JSON.parse(await readFile(path, "utf8")))
    if (!value) throw new Error("Expected a JSON object.")
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read JSON at ${path}: ${message}`)
  }
}

export async function writeJsonObject(path: string, value: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", "utf8")
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}
