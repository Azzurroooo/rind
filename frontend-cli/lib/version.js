import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function readCliVersion(frontendRoot = fileURLToPath(new URL("../", import.meta.url))) {
  const metadata = JSON.parse(readFileSync(path.join(frontendRoot, "package.json"), "utf8"));
  if (typeof metadata.version === "string" && metadata.version) return metadata.version;
  const srcVersionPath = path.join(frontendRoot, "..", "runtime", "src", "version.ts");
  const distVersionPath = path.join(frontendRoot, "..", "runtime", "dist", "version.js");
  const versionPath = existsSync(srcVersionPath) ? srcVersionPath : distVersionPath;
  const source = readFileSync(versionPath, "utf8");
  const version = source.match(/RIND_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (!version) throw new Error("Rind version is missing from runtime/src/version.ts.");
  return version;
}
