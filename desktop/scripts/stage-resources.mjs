import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(desktopRoot, "..")
const resourcesDir = path.join(desktopRoot, "resources")

function runNpmBuild(projectDir) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const result = spawnSync(npmCmd, ["--prefix", projectDir, "run", "build"], {
    cwd: desktopRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function collectProductionPackages(pkgRoot) {
  const resolvedRoot = path.resolve(pkgRoot)
  const rootPrefix = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot
  const withinRoot = (candidate) => {
    const norm = process.platform === "win32" ? candidate.toLowerCase() : candidate
    return norm === rootPrefix || norm.startsWith(rootPrefix + path.sep)
  }
  const seen = new Set()
  const queue = [[resolvedRoot, JSON.parse(readFileSync(path.join(resolvedRoot, "package.json"), "utf8"))]]
  while (queue.length > 0) {
    const [currentDir, pkg] = queue.shift()
    const depNames = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]
    for (const depName of depNames) {
      let cursor = currentDir
      while (withinRoot(cursor)) {
        const candidate = path.resolve(cursor, "node_modules", depName)
        const manifestPath = path.join(candidate, "package.json")
        if (existsSync(manifestPath)) {
          if (!seen.has(candidate)) {
            seen.add(candidate)
            queue.push([candidate, JSON.parse(readFileSync(manifestPath, "utf8"))])
          }
          break
        }
        const parent = path.dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
    }
  }
  return [...seen].sort((a, b) => a.length - b.length)
}

runNpmBuild(path.join(repoRoot, "runtime"))
runNpmBuild(path.join(repoRoot, "agent-management"))

const stagedRuntime = path.join(resourcesDir, "runtime")
const stagedClient = path.join(resourcesDir, "rind-runtime-client")
const stagedManagement = path.join(resourcesDir, "agent-management")

await rm(stagedRuntime, { recursive: true, force: true })
await rm(stagedClient, { recursive: true, force: true })
await rm(stagedManagement, { recursive: true, force: true })

await mkdir(stagedRuntime, { recursive: true })
for (const entry of ["dist", "skills", "package.json"]) {
  await cp(path.join(repoRoot, "runtime", entry), path.join(stagedRuntime, entry), { recursive: true })
}
const runtimeRoot = path.join(repoRoot, "runtime")
if (existsSync(path.join(runtimeRoot, "node_modules"))) {
  for (const pkgDir of collectProductionPackages(runtimeRoot)) {
    const rel = path.relative(runtimeRoot, pkgDir)
    await cp(pkgDir, path.join(stagedRuntime, rel), {
      recursive: true,
      filter: (src) => src === pkgDir || path.basename(src) !== "node_modules",
    })
  }
}

await cp(path.join(repoRoot, "rind-runtime-client"), stagedClient, {
  recursive: true,
  filter: (src) => path.basename(src) !== "node_modules",
})

await mkdir(stagedManagement, { recursive: true })
for (const entry of ["dist", "package.json"]) {
  await cp(path.join(repoRoot, "agent-management", entry), path.join(stagedManagement, entry), { recursive: true })
}
const managementRequire = createRequire(path.join(repoRoot, "agent-management", "package.json"))
const yamlPkgDir = path.dirname(managementRequire.resolve("yaml/package.json"))
await cp(yamlPkgDir, path.join(stagedManagement, "node_modules", "yaml"), { recursive: true })

console.log("Staged Desktop resources: runtime, rind-runtime-client, and agent-management.")
