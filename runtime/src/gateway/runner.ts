import path from "node:path";
import { type RegistryOptions, buildChannel } from "./channels/index.js";
import type { GatewayConfig } from "./config.js";
import { TurnPump } from "./pump.js";
import { SessionRouter } from "./router.js";
import { CooldownGate, type PairingStore, SecurityGate } from "./security.js";
import type { Transport } from "./transports.js";
import type { Channel } from "./types.js";
import { WorkerClient, WorkerError } from "./worker-client.js";

export interface RunGatewayOptions {
  readonly transport?: Transport;
  readonly registryOptions?: RegistryOptions;
  readonly signal?: AbortSignal;
  readonly logger?: (message: string) => void;
}

export async function runGateway(
  config: GatewayConfig,
  runtimeDir: string,
  pairing: PairingStore,
  options?: RunGatewayOptions,
): Promise<number> {
  const router = new SessionRouter(path.join(runtimeDir, "state.json"));
  const cursorFor = (sessionId: string): number => {
    const key = router.keyForSession(sessionId);
    return key ? router.cursorFor(key) : 0;
  };

  const worker = new WorkerClient(config.worker, config.worker_token, {
    transport: options?.transport,
    cursorProvider: cursorFor,
  });

  const allowFrom: Record<string, readonly string[]> = {};
  const groupAllow: Record<string, readonly string[]> = {};
  for (const [channelId, ch] of Object.entries(config.channels)) {
    allowFrom[channelId] = ch.allow_from;
    groupAllow[channelId] = ch.group_allow;
  }

  const security = new SecurityGate({
    pairing,
    cooldown: new CooldownGate(config.cooldown_per_minute),
    allowFrom,
    groupAllow,
    pairingEnabled: config.pairing.enabled,
    pairingTtlSeconds: config.pairing.ttl_minutes * 60,
  });

  const pump = new TurnPump({
    worker,
    router,
    security,
    workspaceRoot: config.workspace,
  });

  await worker.start();
  for (const [key, record] of Object.entries(router.allSessions())) {
    try {
      await worker.subscribe(record.session_id);
    } catch (err) {
      if (err instanceof WorkerError) {
        options?.logger?.(`gateway: resubscribe of ${key} failed: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  const uploadsRoot = path.join(config.workspace, config.uploads_dir);
  const startedChannels: Channel[] = [];
  for (const [channelId, channelConfig] of Object.entries(config.channels)) {
    const channel = await buildChannel(channelId, channelConfig, uploadsRoot, {
      ...options?.registryOptions,
      logger: options?.logger ?? options?.registryOptions?.logger,
    });
    if (!channel) {
      continue;
    }
    pump.registerChannel(channel);
    try {
      await channel.start(pump);
      startedChannels.push(channel);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      options?.logger?.(
        `gateway: channel ${channelId} failed to start; disabled: ${detail}`,
      );
    }
  }

  const abortController = new AbortController();
  const onSignal = (): void => abortController.abort();
  if (options?.signal) {
    if (options.signal.aborted) {
      abortController.abort();
    } else {
      options.signal.addEventListener("abort", onSignal, { once: true });
    }
  } else {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  try {
    await pump.run(abortController.signal);
  } finally {
    if (!options?.signal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    for (const ch of startedChannels) {
      await ch.stop().catch(() => {});
    }
    await worker.stop().catch(() => {});
  }
  return 0;
}
