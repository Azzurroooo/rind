import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import { GUIDES } from "./onboarding.js";
import {
  type WebSocketFactory,
  WebSocketTransport,
  appendTokenToUrl,
} from "./transports.js";

function loadJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface WorkerAliveOptions {
  readonly timeoutMs?: number;
  readonly wsFactory?: WebSocketFactory;
}

export async function workerAlive(
  worker: string,
  token: string | null,
  options?: WorkerAliveOptions,
): Promise<readonly [boolean, string]> {
  // BUG FIX 6: handle stdio mode cleanly without attempting to open a WS URL "stdio"
  if (worker === "stdio") {
    return [true, "stdio mode: the gateway spawns the worker subprocess itself"];
  }
  const timeoutMs = options?.timeoutMs ?? 5000;
  const wsUrl = appendTokenToUrl(worker, token);
  const transport = new WebSocketTransport(wsUrl, {
    openTimeoutMs: timeoutMs,
    wsFactory: options?.wsFactory,
  });
  const deadline = performance.now() + timeoutMs;

  const probe = async (): Promise<readonly [boolean, string]> => {
    await transport.open();
    await transport.write({
      kind: "request",
      request_id: "status-1",
      method: "initialize",
      params: {},
    });
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return [false, "initialize timed out"];
      }
      const envelope = await Promise.race([
        transport.read(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), remaining)),
      ]);
      if (envelope === null) {
        return [false, "initialize timed out"];
      }
      if (envelope.kind === "response") {
        if (envelope.ok === false) {
          return [false, "initialize rejected by worker"];
        }
        return [true, "worker online, initialize passed"];
      }
    }
  };

  try {
    return await Promise.race([
      probe(),
      new Promise<readonly [boolean, string]>(resolve =>
        setTimeout(() => resolve([false, "initialize timed out"]), timeoutMs + 1000),
      ),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return [false, `cannot connect: ${detail}`];
  } finally {
    await transport.close().catch(() => {});
  }
}

export interface StatusArgs {
  readonly config?: string | null;
  readonly workspace?: string;
}

export interface StatusOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly workerAliveImpl?: (
    worker: string,
    token: string | null,
  ) => Promise<readonly [boolean, string]>;
}

export async function runStatus(
  args: StatusArgs,
  options?: StatusOptions,
): Promise<number> {
  const out = options?.stdout ?? (line => console.log(line));
  const errOut = options?.stderr ?? (line => console.error(line));
  const workspace = path.resolve(args.workspace || ".");
  const configPath = args.config
    ? path.resolve(args.config)
    : path.join(workspace, ".rind", "gateway.yaml");

  let config;
  try {
    config = loadConfig(configPath, { env: options?.env });
  } catch (err) {
    if (err instanceof ConfigError) {
      errOut(`Gateway not configured: ${err.message}`);
      errOut("Run `rind gateway init` to create the config step by step.");
      return 2;
    }
    throw err;
  }

  out("Rind gateway status");
  out(`  config: ${configPath}`);

  // BUG FIX 6: resolve .rind/state.json and .rind/pairing.json from config.workspace
  const runtimeDir = path.join(config.workspace, ".rind");

  const state = loadJsonSafe(path.join(runtimeDir, "state.json")) ?? {};
  const sessionsObj =
    state.sessions && typeof state.sessions === "object" && !Array.isArray(state.sessions)
      ? (state.sessions as Record<string, unknown>)
      : {};
  const sessionEntries = Object.entries(sessionsObj);
  out(`  session mappings: ${sessionEntries.length}`);
  for (const [key, record] of sessionEntries.slice(0, 8)) {
    const rec =
      record && typeof record === "object" && !Array.isArray(record)
        ? (record as Record<string, unknown>)
        : null;
    const sessionId = rec ? String(rec.session_id ?? "?") : "?";
    const cursor = rec ? String(rec.cursor ?? 0) : "?";
    out(`    · ${key} → ${sessionId} (cursor ${cursor})`);
  }
  if (sessionEntries.length > 8) {
    out(`    … ${sessionEntries.length - 8} more`);
  }

  const pairing = loadJsonSafe(path.join(runtimeDir, "pairing.json")) ?? {};
  const pendingObj =
    pairing.pending &&
    typeof pairing.pending === "object" &&
    !Array.isArray(pairing.pending)
      ? (pairing.pending as Record<string, unknown>)
      : {};
  const approvedArr = Array.isArray(pairing.approved) ? pairing.approved : [];
  const pendingEntries = Object.entries(pendingObj);
  out(`  pairing: ${pendingEntries.length} pending, ${approvedArr.length} approved`);
  for (const [code, entry] of pendingEntries.slice(0, 5)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      out(`    · ${code} (${String(e.channel ?? "?")} · ${String(e.sender_id ?? "?")})`);
    }
  }
  if (pendingEntries.length > 0) {
    out("    approve: rind gateway approve <code>");
  }

  for (const [channelId, channel] of Object.entries(config.channels)) {
    const guide = GUIDES[channelId];
    const label = guide ? guide.label : channelId;
    out(
      `  channel ${label}: allow_from ${channel.allow_from.length} entries · group_allow ${channel.group_allow.length} entries`,
    );
  }

  const checkWorker = options?.workerAliveImpl ?? workerAlive;
  const [alive, detail] = await checkWorker(config.worker, config.worker_token);
  const mark = alive ? "✔" : "✘";
  out(`  worker: ${mark} ${detail} (${config.worker})`);
  return alive ? 0 : 1;
}
