#!/usr/bin/env node
import { appServerMain } from "./server/transports.js";
import { VERSION } from "./version.js";

function printHelp(): void {
  const text = [
    "usage: rind-runtime app-server [options]",
    "",
    "Rind headless runtime server",
    "",
    "options:",
    "  --version               Show version and exit",
    "  -h, --help              Show this help message and exit",
    "  --stdio                 Use the JSONL standard-stream transport",
    "  --web                   Use the WebSocket transport",
    "  --host <host>           WebSocket bind host (default: 127.0.0.1)",
    "  --port <port>           WebSocket bind port (default: 8765)",
    "  --debug                 Enable debug mode",
    "  --cwd <dir>             Workspace directory for this runtime",
    "  --session <id>          Resume specific session ID",
    "  -c, --resume-latest     Resume most recent saved session",
    "  --session-dir <dir>     Session storage root directory",
    "  --no-user-question      Disable the interactive user-question tool",
    "  --trace-llm             Record every LLM request/response under <session>/_llm_trace/ (debug).",
  ].join("\n");
  process.stdout.write(`${text}\n`);
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = [...argv];
  if (args.includes("--version")) {
    process.stdout.write(`rind ${VERSION}\n`);
    return 0;
  }
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return 0;
  }
  if (args[0] === "app-server") {
    return await appServerMain(args.slice(1));
  }
  if (args.length === 0) {
    process.stderr.write("rind-runtime: error: the following argument is required: command\n");
    return 2;
  }
  process.stderr.write(
    `rind-runtime: error: invalid choice: '${args[0]}' (choose from 'app-server')\n`,
  );
  return 2;
}

const isMain = (() => {
  try {
    const entry = process.argv[1] || "";
    return (
      entry.endsWith("/cli.js") ||
      entry.endsWith("\\cli.js") ||
      entry.endsWith("/cli.ts")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().then(
    code => {
      process.exitCode = code;
    },
    err => {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      process.stderr.write(`Fatal runtime error: ${msg}\n`);
      process.exit(1);
    },
  );
}
