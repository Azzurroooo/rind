import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
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

function skipNodeModulesArtifacts(src) {
  const base = path.basename(src)
  const parent = path.basename(path.dirname(src))
  return !(parent === "node_modules" && (base === ".bin" || base === ".cache"))
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
const runtimeNodeModules = path.join(repoRoot, "runtime", "node_modules")
if (existsSync(runtimeNodeModules)) {
  await cp(runtimeNodeModules, path.join(stagedRuntime, "node_modules"), {
    recursive: true,
    filter: skipNodeModulesArtifacts,
  })
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
