import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let wasmSource = "";
try {
  wasmSource = require.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");
} catch {
  const fallback = path.join(
    runtimeRoot,
    "node_modules",
    "@silvia-odwyer",
    "photon-node",
    "photon_rs_bg.wasm",
  );
  if (existsSync(fallback)) {
    wasmSource = fallback;
  }
}

if (wasmSource && existsSync(wasmSource)) {
  const targets = [
    path.join(runtimeRoot, "dist", "photon_rs_bg.wasm"),
    path.join(runtimeRoot, "dist", "infrastructure", "photon_rs_bg.wasm"),
  ];
  for (const target of targets) {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(wasmSource, target);
  }
}
