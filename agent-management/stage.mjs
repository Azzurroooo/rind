import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error("Usage: node agent-management/stage.mjs <new-absolute-directory>");
const require = createRequire(import.meta.url);
const build = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(root, "agent-management/tsconfig.json")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);
const buildRuntime = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(root, "runtime/tsconfig.json")], { stdio: "inherit" });
if (buildRuntime.status !== 0) process.exit(buildRuntime.status || 1);
await mkdir(destination); // Never overwrite an existing distribution.
for (const relative of ["frontend-cli/bin", "frontend-cli/lib", "rind-runtime-client", "agent-management/dist", "runtime/dist", "runtime/skills"]) {
  await cp(path.join(root, relative), path.join(destination, relative), { recursive: true, errorOnExist: true, force: false });
}
for (const relative of ["frontend-cli/package.json", "agent-management/package.json", "runtime/package.json"]) {
  await cp(path.join(root, relative), path.join(destination, relative));
}
await cp(path.dirname(require.resolve("yaml/package.json")), path.join(destination, "agent-management/node_modules/yaml"), { recursive: true });
const version = (await readFile(path.join(root, "runtime/src/version.ts"), "utf8")).match(/RIND_VERSION\s*=\s*["']([^"']+)/)?.[1];
if (!version) throw new Error("Cannot read the Rind version.");
await writeFile(path.join(destination, "package.json"), JSON.stringify({ name: "@rind-ai/cli", version, type: "module", bin: { rind: "frontend-cli/bin/rind.js" }, engines: { node: ">=18" } }, null, 2) + "\n");
const cliPackage = JSON.parse(await readFile(path.join(destination, "frontend-cli/package.json"), "utf8"));
await writeFile(path.join(destination, "frontend-cli/package.json"), JSON.stringify({ ...cliPackage, version }, null, 2) + "\n");
console.log("Staged CLI, runtime, management service, shared runtime client and YAML dependency at " + destination);
