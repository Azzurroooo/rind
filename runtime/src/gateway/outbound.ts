import { degradeMarkdown, renderChoices, splitText } from "./chunk.js";
import type {
  Channel,
  ChannelCapabilities,
  OutboundPayload,
  ReplyPosition,
  SendTarget,
} from "./types.js";

export const TYPING_RESEND_SECONDS = 3.0;
export const TYPING_TTL_SECONDS = 60.0;
export const TYPING_FAILURE_LIMIT = 2;
export const COMPLETION_REACTION = "✅";
export const DEFAULT_MAX_TEXT_LENGTH = 4000;

interface TypingTask {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(true), ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

export class Outbound {
  private readonly channels: Record<string, Channel>;
  private readonly typingTasks = new Map<string, TypingTask>();
  private readonly typingResendSeconds: number;
  private readonly typingTtlSeconds: number;
  private readonly typingFailureLimit: number;

  constructor(
    channels: Record<string, Channel>,
    options?: {
      typingResendSeconds?: number;
      typingTtlSeconds?: number;
      typingFailureLimit?: number;
    },
  ) {
    this.channels = channels;
    this.typingResendSeconds = options?.typingResendSeconds ?? TYPING_RESEND_SECONDS;
    this.typingTtlSeconds = options?.typingTtlSeconds ?? TYPING_TTL_SECONDS;
    this.typingFailureLimit = options?.typingFailureLimit ?? TYPING_FAILURE_LIMIT;
  }

  register(channel: Channel): void {
    this.channels[channel.id] = channel;
  }

  capabilities(channelId: string): ChannelCapabilities | null {
    return this.channels[channelId]?.capabilities ?? null;
  }

  async send(
    channelId: string,
    target: SendTarget,
    payload: OutboundPayload,
  ): Promise<void> {
    const channel = this.channels[channelId];
    if (!channel) {
      return;
    }
    await channel.send(target, payload);
  }

  async reply(position: ReplyPosition | null, text: string): Promise<void> {
    if (position) {
      await this.send(position[0], position[1], { text });
    }
  }

  async sendQuestion(
    position: ReplyPosition,
    questionText: string,
    options: readonly string[],
  ): Promise<void> {
    const [channelId, target] = position;
    const caps = this.capabilities(channelId);
    const payload: OutboundPayload =
      caps && caps.supports_buttons
        ? { text: questionText, choices: [...options] }
        : { text: `${questionText}\n\n${renderChoices(options)}` };
    await this.send(channelId, target, payload);
  }

  async sendAssistant(
    position: ReplyPosition,
    content: string,
    title: string,
  ): Promise<void> {
    const [channelId, target] = position;
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    const caps = this.capabilities(channelId);
    const limit = caps ? caps.max_text_length : DEFAULT_MAX_TEXT_LENGTH;
    const unit = caps ? caps.len_unit : "chars";
    const text = !caps || caps.markdown === "none" ? degradeMarkdown(trimmed) : trimmed;
    const pieces = splitText(text, limit, unit);
    for (let index = 0; index < pieces.length; index += 1) {
      let piece = pieces[index]!;
      if (index === 0 && title) {
        piece = `${title}\n${piece}`;
      }
      await this.send(channelId, target, { text: piece });
    }
  }

  startTyping(key: string, channelId: string, target: SendTarget): void {
    const caps = this.capabilities(channelId);
    const channel = this.channels[channelId];
    if (!caps || !caps.supports_typing || !channel || typeof channel.typing !== "function") {
      return;
    }
    const previous = this.typingTasks.get(key);
    if (previous) {
      this.typingTasks.delete(key);
      previous.controller.abort();
    }
    const controller = new AbortController();
    const promise = this.keepalive(channel, target, controller.signal);
    this.typingTasks.set(key, { controller, promise });
  }

  async stopTyping(key: string): Promise<void> {
    const task = this.typingTasks.get(key);
    if (!task) {
      return;
    }
    this.typingTasks.delete(key);
    task.controller.abort();
    await task.promise;
  }

  private async keepalive(
    channel: Channel,
    target: SendTarget,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0;
    const started = performance.now() / 1000;
    while (!signal.aborted) {
      try {
        await channel.typing?.(target);
        failures = 0;
      } catch {
        if (signal.aborted) {
          return;
        }
        failures += 1;
        if (failures >= this.typingFailureLimit) {
          return;
        }
      }
      if (signal.aborted) {
        return;
      }
      if (performance.now() / 1000 - started >= this.typingTtlSeconds) {
        return;
      }
      const ok = await sleepAbortable(
        Math.max(1, this.typingResendSeconds * 1000),
        signal,
      );
      if (!ok) {
        return;
      }
    }
  }

  async reactEmoji(position: ReplyPosition | null, emoji: string): Promise<void> {
    if (!position) {
      return;
    }
    const [channelId, target] = position;
    const channel = this.channels[channelId];
    const caps = this.capabilities(channelId);
    if (!channel || !caps?.supports_reaction || typeof channel.react !== "function") {
      return;
    }
    await channel.react(target, emoji);
  }

  async react(position: ReplyPosition | null): Promise<void> {
    await this.reactEmoji(position, COMPLETION_REACTION);
  }
}
