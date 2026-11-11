export type AttachmentKind = "image" | "audio" | "document" | "video";

export function attachmentKind(contentType: string): AttachmentKind {
  const slash = contentType.indexOf("/");
  if (slash === -1) {
    return "document";
  }
  const kind = contentType.slice(0, slash);
  if (kind === "image" || kind === "audio" || kind === "video") {
    return kind;
  }
  return "document";
}

export interface Attachment {
  readonly path: string;
  readonly content_type: string;
  readonly kind: AttachmentKind;
}

export interface InboundMessage {
  readonly channel: string;
  readonly chat_id: string;
  readonly chat_type: "dm" | "group" | string;
  readonly sender_id: string;
  readonly sender_name: string;
  readonly thread_id: string | null;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly message_ref: string;
}

export interface ChannelCapabilities {
  readonly max_text_length: number;
  readonly len_unit: "chars" | "utf16";
  readonly supports_typing: boolean;
  readonly supports_buttons: boolean;
  readonly supports_reaction: boolean;
  readonly markdown: "none" | "subset";
}

export const DEFAULT_CAPABILITIES: ChannelCapabilities = Object.freeze({
  max_text_length: 4000,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "none",
});

export function createCapabilities(
  overrides: Partial<ChannelCapabilities> = {},
): ChannelCapabilities {
  return Object.freeze({
    ...DEFAULT_CAPABILITIES,
    ...overrides,
  });
}

export interface SendTarget {
  readonly chat_id: string;
  readonly thread_id?: string | null;
}

export interface OutboundPayload {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly choices?: readonly string[];
}

export interface InboundSink {
  inbound(message: InboundMessage): Promise<void>;
}

export interface OutboundSink {
  send(target: SendTarget, payload: OutboundPayload): Promise<void>;
  typing(target: SendTarget): Promise<void>;
}

export interface Channel {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(target: SendTarget, payload: OutboundPayload): Promise<void>;
  typing?(target: SendTarget): Promise<void>;
  react?(target: SendTarget, emoji: string): Promise<void>;
}

export type ReplyPosition = readonly [channelId: string, target: SendTarget];
