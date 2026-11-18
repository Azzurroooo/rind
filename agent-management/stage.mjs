import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

function collectProductionPackages(pkgRoot) {
  const resolvedRoot = path.resolve(pkgRoot);
  const rootPrefix = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const withinRoot = (candidate) => {
    const norm = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    return norm === rootPrefix || norm.startsWith(rootPrefix + path.sep);
  };
  const seen = new Set();
  const queue = [[resolvedRoot, JSON.parse(readFileSync(path.join(resolvedRoot, "package.json"), "utf8"))]];
  while (queue.length > 0) {
    const [currentDir, pkg] = queue.shift();
    const depNames = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ];
    for (const depName of depNames) {
      let cursor = currentDir;
      while (withinRoot(cursor)) {
        const candidate = path.resolve(cursor, "node_modules", depName);
        const manifestPath = path.join(candidate, "package.json");
        if (existsSync(manifestPath)) {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            queue.push([candidate, JSON.parse(readFileSync(manifestPath, "utf8"))]);
          }
          break;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
  }
  return [...seen].sort((a, b) => a.length - b.length);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const rawArgs = process.argv.slice(2);
const skipBuild = rawArgs.includes("--skip-build");
const positionalArgs = rawArgs.filter((arg) => !arg.startsWith("-"));
const unknownFlags = rawArgs.filter((arg) => arg.startsWith("-") && arg !== "--skip-build");
const destination = positionalArgs[0];
if (!destination || positionalArgs.length !== 1 || unknownFlags.length > 0 || !path.isAbsolute(destination)) {
  throw new Error("Usage: node agent-management/stage.mjs [--skip-build] <new-absolute-directory>");
}
const require = createRequire(import.meta.url);
if (!skipBuild) {
  const buildRuntime = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(root, "runtime/tsconfig.json")], { stdio: "inherit" });
  if (buildRuntime.status !== 0) process.exit(buildRuntime.status || 1);
  const copyAssetsScript = path.join(root, "runtime/scripts/copy-assets.mjs");
  if (existsSync(copyAssetsScript)) {
    const copyAssets = spawnSync(process.execPath, [copyAssetsScript], { stdio: "inherit" });
    if (copyAssets.status !== 0) process.exit(copyAssets.status || 1);
  }
  const build = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(root, "agent-management/tsconfig.json")], { stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status || 1);
} else {
  for (const requiredDist of ["agent-management/dist/service.js", "runtime/dist/cli.js"]) {
    if (!existsSync(path.join(root, requiredDist))) {
      throw new Error(`--skip-build requires prebuilt output at ${requiredDist}`);
    }
  }
}
await mkdir(destination); // Never overwrite an existing distribution.
for (const relative of ["frontend-cli/bin", "frontend-cli/lib", "agent-management/dist", "runtime/dist", "runtime/skills"]) {
  await cp(path.join(root, relative), path.join(destination, relative), { recursive: true, errorOnExist: true, force: false });
}
const runtimeRoot = path.join(root, "runtime");
if (existsSync(path.join(runtimeRoot, "node_modules"))) {
  for (const pkgDir of collectProductionPackages(runtimeRoot)) {
    const rel = path.relative(runtimeRoot, pkgDir);
    await cp(pkgDir, path.join(destination, "runtime", rel), {
      recursive: true,
      filter: (src) => src === pkgDir || path.basename(src) !== "node_modules",
    });
  }
}
for (const relative of ["frontend-cli/package.json", "agent-management/package.json", "runtime/package.json"]) {
  await cp(path.join(root, relative), path.join(destination, relative));
}
await cp(path.dirname(require.resolve("yaml/package.json")), path.join(destination, "agent-management/node_modules/yaml"), { recursive: true });
const version = (await readFile(path.join(root, "runtime/src/version.ts"), "utf8")).match(/RIND_VERSION\s*=\s*["']([^"']+)/)?.[1];
if (!version) throw new Error("Cannot read the Rind version.");
await writeFile(path.join(destination, "package.json"), JSON.stringify({ name: "@rind-ai/cli", version, type: "module", bin: { rind: "frontend-cli/bin/rind.js" }, engines: { node: ">=20" } }, null, 2) + "\n");
const cliPackage = JSON.parse(await readFile(path.join(destination, "frontend-cli/package.json"), "utf8"));
await writeFile(path.join(destination, "frontend-cli/package.json"), JSON.stringify({ ...cliPackage, version }, null, 2) + "\n");
console.log("Staged CLI, runtime, management service and dependencies at " + destination);
