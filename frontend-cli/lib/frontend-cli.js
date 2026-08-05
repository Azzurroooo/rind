import { runFrontendCliApp } from "./frontend-cli-implementation.js";

export function runFrontendCli(cliArgs = process.argv.slice(2)) {
  return runFrontendCliApp(cliArgs);
}
