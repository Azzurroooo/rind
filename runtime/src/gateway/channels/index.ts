import type { ChannelConfig } from "../config.js";
import type { Channel } from "../types.js";

export type ChannelBuilder = (
  config: ChannelConfig,
  uploadsRoot: string,
  options?: Record<string, unknown>,
) => Promise<Channel> | Channel;

export const LOADERS: Readonly<Record<string, () => Promise<{ buildChannel: ChannelBuilder }>>> =
  Object.freeze({
    telegram: () =>
      import("./telegram.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
    discord: () =>
      import("./discord.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
    wecom: () =>
      import("./wecom.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
    whatsapp: () =>
      import("./whatsapp-cloud.js") as unknown as Promise<{
        buildChannel: ChannelBuilder;
      }>,
    email: () =>
      import("./email-channel.js") as unknown as Promise<{
        buildChannel: ChannelBuilder;
      }>,
    slack: () =>
      import("./slack.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
    qq: () =>
      import("./qq.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
    feishu: () =>
      import("./feishu.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
    dingtalk: () =>
      import("./dingtalk.js") as unknown as Promise<{ buildChannel: ChannelBuilder }>,
  });

export interface RegistryOptions {
  readonly loaders?: Readonly<
    Record<string, () => Promise<{ buildChannel: ChannelBuilder }>>
  >;
  readonly channelOptions?: Record<string, unknown>;
  readonly logger?: (message: string) => void;
}

export async function buildChannel(
  channelId: string,
  config: ChannelConfig,
  uploadsRoot: string,
  options?: RegistryOptions,
): Promise<Channel | null> {
  const loaders = options?.loaders ?? LOADERS;
  const loader = loaders[channelId];
  const log = options?.logger;
  if (!loader) {
    log?.(`gateway: no adapter installed for channel '${channelId}'; channel disabled`);
    return null;
  }
  try {
    const mod = await loader();
    return await mod.buildChannel(config, uploadsRoot, options?.channelOptions);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.(`gateway: channel ${channelId} failed to start; disabled: ${detail}`);
    return null;
  }
}
