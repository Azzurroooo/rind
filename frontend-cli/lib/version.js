import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function readCliVersion(frontendRoot = fileURLToPath(new URL("../", import.meta.url))) {
  const metadata = JSON.parse(readFileSync(path.join(frontendRoot, "package.json"), "utf8"));
  if (typeof metadata.version === "string" && metadata.version) return metadata.version;
  const source = readFileSync(path.join(frontendRoot, "..", "agent", "version.py"), "utf8");
  const version = source.match(/^__version__\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!version) throw new Error("Rind version is missing from agent/version.py.");
  return version;
}
