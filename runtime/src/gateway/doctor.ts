import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import { type ChannelGuide, GUIDES } from "./onboarding.js";
import { workerAlive } from "./status.js";

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean | null; // null = warning
  readonly detail: string;
  readonly fix: string;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function looksLikeSourceDir(dirPath: string): boolean {
  return (
    isFile(path.join(dirPath, "runtime", "src", "cli.ts")) &&
    isDirectory(path.join(dirPath, "frontend-cli"))
  );
}

function readJsonCheck(filePath: string): readonly [boolean, unknown] {
  if (!fs.existsSync(filePath)) {
    return [true, null];
  }
  try {
    return [true, JSON.parse(fs.readFileSync(filePath, "utf8"))];
  } catch {
    return [false, null];
  }
}

function fixCorrupt(filePath: string): string {
  const backup = `${filePath}.corrupt`;
  try {
    fs.renameSync(filePath, backup);
    return `backed up as ${path.basename(backup)}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `rename failed: ${detail}`;
  }
}

export async function ensureChannelSdks(
  guides: readonly ChannelGuide[],
  _options?: {
    interactive?: boolean;
    confirm?: (label: string) => Promise<boolean>;
    echo?: (line: string) => void;
  },
): Promise<readonly [ChannelGuide[], boolean]> {
  // All channel transports and SDKs are built-in / bundled in runtime/node_modules.
  return [[...guides], false];
}

export interface RunChecksOptions {
  readonly probe?: boolean;
  readonly fix?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly workerAliveImpl?: (
    worker: string,
    token: string | null,
  ) => Promise<readonly [boolean, string]>;
  readonly sdkChecker?: (
    channelId: string,
  ) => Promise<readonly [boolean, string]> | readonly [boolean, string];
}

export async function runChecks(
  configPath: string | null | undefined,
  workspace: string,
  options?: RunChecksOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean | null, detail: string, fix = ""): void => {
    results.push({ name, ok, detail, fix });
  };

  const targetPath = configPath
    ? path.resolve(configPath)
    : path.join(path.resolve(workspace), ".rind", "gateway.yaml");
  if (!isFile(targetPath)) {
    add(
      "config file",
      false,
      `not found: ${targetPath}`,
      "run `rind gateway init` to create one (about 2 minutes)",
    );
    return results;
  }

  let config;
  try {
    config = loadConfig(targetPath, { env: options?.env });
    add("config file", true, `${targetPath} parses cleanly`);
  } catch (err) {
    if (err instanceof ConfigError) {
      add(
        "config file",
        false,
        err.message,
        "fix per the message and rerun, or regenerate with `rind gateway init`",
      );
      return results;
    }
    throw err;
  }

  if (config.worker === "stdio") {
    add(
      "worker connection",
      true,
      "stdio mode: the gateway spawns the worker subprocess itself",
    );
  } else {
    const checkWorker =
      options?.workerAliveImpl ??
      ((w: string, t: string | null) => workerAlive(w, t, { timeoutMs: 5000 }));
    const [alive, detail] = await checkWorker(config.worker, config.worker_token);
    add(
      "worker connection",
      alive,
      `${config.worker} — ${detail}`,
      alive
        ? ""
        : "confirm the worker is running (rind app-server --host 127.0.0.1 --port 8765) and the worker_token matches",
    );
  }

  if (!isDirectory(config.workspace)) {
    add(
      "workspace directory",
      false,
      `directory missing: ${config.workspace}`,
      "set workspace in gateway.yaml to an absolute path",
    );
  } else if (looksLikeSourceDir(config.workspace)) {
    add(
      "workspace directory",
      null,
      `${config.workspace} looks like the Rind source tree — runtime data (state/pairing/uploads) would mix into it`,
      "use a dedicated directory for gateway sessions (e.g. ~/rind-workspace)",
    );
  } else {
    add("workspace directory", true, config.workspace);
  }

  const runtimeDir = path.join(config.workspace, ".rind");
  for (const name of ["state.json", "pairing.json"]) {
    const file = path.join(runtimeDir, name);
    const [readable, data] = readJsonCheck(file);
    if (readable) {
      add(
        name,
        true,
        data ? "readable" : "not created yet (appears after first run)",
      );
    } else if (options?.fix) {
      add(name, true, `corrupt, ${fixCorrupt(file)} (reset)`);
    } else {
      add(name, false, "corrupt", "add --fix to back up and reset automatically");
    }
  }

  const channelEntries = Object.entries(config.channels);
  for (const [channelId, channel] of channelEntries) {
    const guide = GUIDES[channelId];
    const label = guide ? guide.label : channelId;
    if (options?.sdkChecker) {
      const [sdkOk, sdkDetail] = await options.sdkChecker(channelId);
      if (!sdkOk) {
        add(`channel ${label}`, false, sdkDetail);
        continue;
      }
    }
    if (guide?.probe && options?.probe) {
      const answers: Record<string, unknown> = {
        ...(channel.token ? { token: channel.token } : {}),
        ...channel.extra,
      };
      const missing = guide.fields
        .filter(spec => spec.required && !answers[spec.name])
        .map(spec => spec.name);
      if (missing.length > 0) {
        add(
          `channel ${label}`,
          false,
          `missing required fields: ${missing.join(", ")}`,
        );
        continue;
      }
      const probeResult = await guide.probe(answers);
      add(`channel ${label} credentials`, probeResult.ok, probeResult.detail);
    } else {
      add(
        `channel ${label}`,
        true,
        "configured (add --probe to verify credentials)",
      );
    }
  }

  if (channelEntries.length === 0) {
    add(
      "channels",
      null,
      "no channels configured yet",
      "run `rind gateway init` to add one",
    );
  }

  return results;
}

export interface DoctorArgs {
  readonly config?: string | null;
  readonly workspace?: string;
  readonly probe?: boolean;
  readonly fix?: boolean;
}

export interface DoctorOptions extends RunChecksOptions {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export async function runDoctor(
  args: DoctorArgs,
  options?: DoctorOptions,
): Promise<number> {
  const out = options?.stdout ?? (line => console.log(line));
  const errOut = options?.stderr ?? (line => console.error(line));
  const workspace = path.resolve(args.workspace || ".");
  const configPath = args.config ? path.resolve(args.config) : null;
  const results = await runChecks(configPath, workspace, options);

  out("Rind gateway health check");
  let failed = 0;
  for (const check of results) {
    let mark: string;
    if (check.ok === true) {
      mark = "✔";
    } else if (check.ok === null) {
      mark = "⚠";
    } else {
      mark = "✘";
      failed += 1;
    }
    out(`  ${mark} ${check.name}: ${check.detail}`);
    if (check.fix && !check.ok) {
      out(`      ↳ ${check.fix}`);
    }
  }

  if (failed === 0) {
    out("All checks passed. Start: rind gateway --config <config path>");
    return 0;
  }
  errOut(`${failed} check(s) failed.`);
  return 1;
}
