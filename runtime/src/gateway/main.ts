import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { ConfigError, loadConfig, resolveConfigPath } from "./config.js";
import { runDoctor } from "./doctor.js";
import { PromptSession, WizardCancelled } from "./prompt.js";
import { runGateway } from "./runner.js";
import { PairingStore } from "./security.js";
import { runStatus } from "./status.js";
import type { Transport } from "./transports.js";
import { runInit } from "./wizard.js";

export const GATEWAY_USAGE = `Usage: rind gateway [command] [options]

Rind unified message gateway

Commands:
  (none), start          Start the gateway (default when no subcommand is given)
  init                   Create gateway.yaml interactively or via --yes env vars
  approve <code>         Approve a pending 6-character pairing code
  status                 One-screen status: sessions, pairing, channels, worker
  doctor                 Health check (--probe tests live credentials, --fix repairs)

Options:
  --config <path>        Path to gateway.yaml (default: <workspace>/.rind/gateway.yaml)
  --workspace <dir>      Workspace root used for config/state lookup (default: .)
  --channel <csv>        [init] Comma-separated channel ids (e.g. telegram,email)
  --yes                  [init] Non-interactive mode reading RIND_GW_<CHANNEL>_<FIELD>
  --worker-url <url>     [init] Worker URL (default: ws://127.0.0.1:8765)
  --probe                [doctor] Verify channel credentials live
  --fix                  [doctor] Back up and reset corrupt state files (.corrupt)
  -h, --help             Show this help message and exit`;

type Subcommand = "run" | "start" | "init" | "approve" | "status" | "doctor";

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  "start",
  "init",
  "approve",
  "status",
  "doctor",
]);

interface ParsedArgs {
  command: Subcommand;
  config: string | null;
  workspace: string | null;
  code: string | null;
  channel: string;
  yes: boolean;
  workerUrl: string;
  probe: boolean;
  fix: boolean;
  help: boolean;
}

class CliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliParseError";
  }
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function parseGatewayArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "run",
    config: null,
    workspace: null,
    code: null,
    channel: "",
    yes: false,
    workerUrl: "",
    probe: false,
    fix: false,
    help: false,
  };

  let commandExplicit = false;
  const positionals: string[] = [];

  const takeValue = (flag: string, index: number): readonly [string, number] => {
    const eqIdx = flag.indexOf("=");
    if (eqIdx !== -1) {
      return [flag.slice(eqIdx + 1), index];
    }
    if (index + 1 >= argv.length) {
      throw new CliParseError(`gateway: option ${flag} requires an argument`);
    }
    return [argv[index + 1]!, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--yes") {
      parsed.yes = true;
      continue;
    }
    if (arg === "--probe") {
      parsed.probe = true;
      continue;
    }
    if (arg === "--fix") {
      parsed.fix = true;
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const [val, nextIdx] = takeValue(arg, i);
      parsed.config = val;
      i = nextIdx;
      continue;
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const [val, nextIdx] = takeValue(arg, i);
      parsed.workspace = val;
      i = nextIdx;
      continue;
    }
    if (arg === "--channel" || arg.startsWith("--channel=")) {
      const [val, nextIdx] = takeValue(arg, i);
      parsed.channel = val;
      i = nextIdx;
      continue;
    }
    if (arg === "--worker-url" || arg.startsWith("--worker-url=")) {
      const [val, nextIdx] = takeValue(arg, i);
      parsed.workerUrl = val;
      i = nextIdx;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliParseError(`gateway: unrecognized option '${arg}'`);
    }
    if (!commandExplicit && SUBCOMMANDS.has(arg)) {
      parsed.command = arg as Subcommand;
      commandExplicit = true;
      continue;
    }
    positionals.push(arg);
  }

  if (!parsed.help) {
    if (parsed.command === "approve") {
      if (positionals.length === 0) {
        throw new CliParseError("gateway approve: missing required <code> argument");
      }
      if (positionals.length > 1) {
        throw new CliParseError(
          `gateway approve: unexpected extra arguments: ${positionals.slice(1).join(" ")}`,
        );
      }
      parsed.code = positionals[0]!;
    } else if (positionals.length > 0) {
      throw new CliParseError(
        `gateway: unknown subcommand or unexpected argument '${positionals[0]}'`,
      );
    }
  }

  return parsed;
}

export interface GatewayCliOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: Readable | string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly workerAliveImpl?: (
    worker: string,
    token: string | null,
  ) => Promise<readonly [boolean, string]>;
  readonly transport?: Transport;
  readonly signal?: AbortSignal;
}

export async function gatewayMain(
  argv: readonly string[],
  options?: GatewayCliOptions,
): Promise<number> {
  const out = options?.stdout ?? (line => console.log(line));
  const errOut = options?.stderr ?? (line => console.error(line));
  const env = options?.env ?? process.env;

  let args: ParsedArgs;
  try {
    args = parseGatewayArgs(argv);
  } catch (err) {
    if (err instanceof CliParseError) {
      errOut(err.message);
      errOut("Run `rind gateway --help` for usage.");
      return 2;
    }
    throw err;
  }

  if (args.help) {
    out(GATEWAY_USAGE);
    return 0;
  }

  const promptIO = {
    stdin: options?.stdin,
    write: options?.stdout
      ? (text: string) => {
          const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
          options.stdout!(trimmed);
        }
      : undefined,
    writeErr: options?.stderr
      ? (text: string) => {
          const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
          options.stderr!(trimmed);
        }
      : undefined,
  };

  if (args.command === "init") {
    return await runInit(
      {
        channel: args.channel,
        yes: args.yes,
        workerUrl: args.workerUrl,
        workspace: args.workspace ? expandHome(args.workspace) : null,
      },
      {
        env,
        io: promptIO,
        workerAliveImpl: options?.workerAliveImpl,
      },
    );
  }

  const workspace = path.resolve(expandHome(args.workspace || "."));

  if (args.command === "doctor") {
    return await runDoctor(
      {
        config: args.config,
        workspace,
        probe: args.probe,
        fix: args.fix,
      },
      {
        probe: args.probe,
        fix: args.fix,
        env,
        stdout: out,
        stderr: errOut,
        workerAliveImpl: options?.workerAliveImpl,
      },
    );
  }

  if (args.command === "status") {
    return await runStatus(
      {
        config: args.config,
        workspace,
      },
      {
        env,
        stdout: out,
        stderr: errOut,
        workerAliveImpl: options?.workerAliveImpl,
      },
    );
  }

  if (args.command === "approve") {
    let targetWorkspace = workspace;
    if (args.config && !args.workspace) {
      try {
        const cfg = loadConfig(path.resolve(args.config), { env });
        targetWorkspace = cfg.workspace;
      } catch {
        // approve never requires gateway.yaml to exist or parse
      }
    }
    const pairing = new PairingStore(
      path.join(targetWorkspace, ".rind", "pairing.json"),
    );
    const code = args.code ?? "";
    if (pairing.approve(code)) {
      out(`Pairing approved: ${code.trim().toUpperCase()}`);
      return 0;
    }
    errOut(`Pairing code invalid or expired: ${code}`);
    return 1;
  }

  // `start` or bare `(none)` -> run the gateway
  let config;
  try {
    config = loadConfig(resolveConfigPath(args.config, workspace), { env });
  } catch (err) {
    if (err instanceof ConfigError) {
      out(`gateway: ${err.message}`);
      let offer = "n";
      const prompt = new PromptSession(promptIO);
      try {
        offer = (
          await prompt.inputLine(
            "Run the configuration wizard (gateway init) now? [Y/n]: ",
          )
        )
          .trim()
          .toLowerCase();
      } catch (cancelErr) {
        if (cancelErr instanceof WizardCancelled) {
          offer = "n";
        } else {
          prompt.close();
          throw cancelErr;
        }
      }

      if (offer === "" || offer === "y" || offer === "yes") {
        // Share the existing PromptSession so buffered lines from a piped
        // Readable stream (e.g. process.stdin) are never dropped.
        return await runInit(
          {
            channel: "",
            yes: false,
            workerUrl: "",
            workspace,
          },
          {
            env,
            promptSession: prompt,
            workerAliveImpl: options?.workerAliveImpl,
          },
        );
      }
      prompt.close();
      errOut("Run `rind gateway init` to create the config interactively.");
      return 2;
    }
    throw err;
  }

  const runtimeDir = path.join(config.workspace, ".rind");
  const pairing = new PairingStore(path.join(runtimeDir, "pairing.json"));
  try {
    return await runGateway(config, runtimeDir, pairing, {
      transport: options?.transport,
      signal: options?.signal,
      logger: errOut,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    errOut(`gateway: ${detail}`);
    return 1;
  }
}
