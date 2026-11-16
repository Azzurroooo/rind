import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test")
  .filter(name => name.endsWith(".test.js"))
  .sort()
  .map(name => "test/" + name);
const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
