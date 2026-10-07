// Runs every test/*.test.js under `node --test`. Node 18 does not expand
// globs itself, and neither does PowerShell, so the files are listed here.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter(name => name.endsWith(".test.js")).sort().map(name => "test/" + name);
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
