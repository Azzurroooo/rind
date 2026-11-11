import fs from "node:fs";
import path from "node:path";
import type { ChannelConfig } from "../config.js";
import {
  type Attachment,
  type Channel,
  type ChannelCapabilities,
  type InboundMessage,
  type InboundSink,
  type OutboundPayload,
  type SendTarget,
  attachmentKind,
  createCapabilities,
} from "../types.js";
import {
  MAX_ATTACHMENT_BYTES,
  OVERSIZE_NOTICE,
  ensureAttachmentDir,
  safeFilename,
} from "./http-ws-utils.js";

export const CHANNEL_ID = "email";

export const CAPABILITIES: ChannelCapabilities = createCapabilities({
  max_text_length: 60000,
  len_unit: "chars",
  supports_typing: false,
  supports_buttons: false,
  supports_reaction: false,
  markdown: "none",
});

export const DEFAULT_MAILBOX = "INBOX";
export const DEFAULT_POLL_INTERVAL = 30;
export const FALLBACK_SUBJECT = "Message from rind";

const SUBJECT_PREFIX_RE = /^(?:(?:re|fw|fwd)(?:\[\d+\])?\s*:\s*)+/i;

export function normalizeSubject(subject: string): string {
  const base = String(subject ?? "").replace(SUBJECT_PREFIX_RE, "");
  return base.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface ImapFetchedMessage {
  readonly uid: number;
  readonly source?: Buffer | Uint8Array;
}

export interface ImapClientLike {
  readonly capabilities?: Map<string, number | boolean> | Set<string>;
  connect(): Promise<void>;
  mailboxOpen(mailboxPath: string): Promise<unknown>;
  search(
    query: { seen: boolean },
    options?: { uid?: boolean },
  ): Promise<number[] | false>;
  fetch(
    range: number[] | string,
    query: { uid?: boolean; source?: boolean },
    options?: { uid?: boolean },
  ): AsyncIterable<ImapFetchedMessage>;
  messageFlagsAdd?(
    range: number[] | string,
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<unknown>;
  idle?(): Promise<unknown>;
  logout(): Promise<void>;
  close?(): void;
}

export type ImapFactory = (config: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => ImapClientLike;

export interface SmtpMailOptions {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text?: string;
  readonly inReplyTo?: string;
  readonly attachments?: ReadonlyArray<{
    readonly filename: string;
    readonly content: Buffer;
    readonly contentType: string;
  }>;
}

export interface SmtpTransportLike {
  sendMail(mail: SmtpMailOptions): Promise<unknown>;
  close?(): void;
}

export type SmtpTransportFactory = (config: {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
}) => SmtpTransportLike;

interface PostalMimeLike {
  parse(raw: Buffer | Uint8Array | string): Promise<{
    from?: { name?: string; address?: string };
    subject?: string;
    messageId?: string;
    text?: string;
    attachments?: ReadonlyArray<{
      filename?: string | null;
      mimeType?: string;
      content: ArrayBuffer | Uint8Array | string;
    }>;
  }>;
}

interface EmailRuntimeDeps {
  readonly imapFactory: ImapFactory;
  readonly smtpFactory: SmtpTransportFactory;
  readonly parseMime: PostalMimeLike["parse"];
}

async function loadEmailDeps(
  overrides?: EmailBuildOptions,
): Promise<EmailRuntimeDeps> {
  let imapFactory = overrides?.imapFactory;
  if (!imapFactory) {
    const imapMod = (await import("imapflow")) as unknown as {
      ImapFlow: new (opts: Record<string, unknown>) => ImapClientLike;
    };
    imapFactory = cfg =>
      new imapMod.ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.auth,
        logger: false,
      });
  }

  let smtpFactory = overrides?.smtpTransportFactory;
  if (!smtpFactory && overrides?.smtpTransport) {
    const fixed = overrides.smtpTransport;
    smtpFactory = () => fixed;
  }
  if (!smtpFactory) {
    const nmMod = (await import("nodemailer")) as unknown as Record<string, unknown>;
    const nm =
      nmMod.default && typeof nmMod.default === "object"
        ? (nmMod.default as Record<string, unknown>)
        : nmMod;
    const createTransport = nm.createTransport as (
      opts: Record<string, unknown>,
    ) => SmtpTransportLike;
    smtpFactory = cfg =>
      createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        requireTLS: cfg.requireTLS,
        auth: cfg.auth,
      });
  }

  const pmMod = (await import("postal-mime")) as unknown as Record<string, unknown>;
  const PostalMimeCtor = (pmMod.default ?? pmMod) as {
    parse?: PostalMimeLike["parse"];
    new (): PostalMimeLike;
  };
  const parseMime: PostalMimeLike["parse"] =
    typeof PostalMimeCtor.parse === "function"
      ? PostalMimeCtor.parse.bind(PostalMimeCtor)
      : raw => new PostalMimeCtor().parse(raw);

  return { imapFactory, smtpFactory, parseMime };
}

function toBuffer(content: ArrayBuffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (content instanceof ArrayBuffer) return Buffer.from(new Uint8Array(content));
  return Buffer.from(String(content), "utf8");
}

interface ParsedMailItem {
  readonly uid: number;
  readonly address: string;
  readonly name: string;
  readonly messageRef: string;
  readonly threadId: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly contentType: string;
    readonly payload: Buffer;
  }>;
}

export interface EmailChannelOptions {
  readonly imapHost: string;
  readonly imapPort?: number;
  readonly imapSsl?: boolean;
  readonly smtpHost: string;
  readonly smtpPort?: number;
  readonly smtpStarttls?: boolean;
  readonly username: string;
  readonly password: string;
  readonly mailbox?: string;
  readonly pollInterval?: number;
  readonly uploadsRoot: string;
  readonly deps?: EmailRuntimeDeps;
}

export class EmailChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly capabilities = CAPABILITIES;

  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSsl: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpStarttls: boolean;
  readonly username: string;
  readonly password: string;
  readonly mailbox: string;
  readonly pollInterval: number;
  private readonly uploadsRoot: string;
  private deps: EmailRuntimeDeps | null;
  private sink: InboundSink | null = null;
  private imap: ImapClientLike | null = null;
  private idleSupported = false;
  private stopController: AbortController | null = null;
  private pollTask: Promise<void> | null = null;
  private readonly threadRefs = new Map<string, readonly [messageId: string, subject: string]>();

  constructor(options: EmailChannelOptions) {
    this.imapHost = options.imapHost;
    this.imapSsl = options.imapSsl ?? true;
    this.imapPort = options.imapPort ?? (this.imapSsl ? 993 : 143);
    this.smtpHost = options.smtpHost;
    this.smtpStarttls = options.smtpStarttls ?? false;
    this.smtpPort = options.smtpPort ?? (this.smtpStarttls ? 587 : 25);
    this.username = options.username;
    this.password = options.password;
    this.mailbox = options.mailbox || DEFAULT_MAILBOX;
    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.uploadsRoot = path.resolve(options.uploadsRoot);
    this.deps = options.deps ?? null;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    if (!this.deps) {
      this.deps = await loadEmailDeps();
    }
    this.stopController = new AbortController();
    this.pollTask = this.pollLoop(this.stopController.signal);
  }

  async stop(): Promise<void> {
    this.stopController?.abort();
    this.stopController = null;
    const task = this.pollTask;
    this.pollTask = null;
    await this.resetImap();
    if (task) {
      await Promise.allSettled([task]);
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const unseen = await this.fetchUnseen();
        for (const item of unseen) {
          if (signal.aborted) return;
          await this.deliver(item);
        }
      } catch {
        await this.resetImap();
      }
      if (signal.aborted) return;
      if (this.idleSupported && this.imap && typeof this.imap.idle === "function") {
        try {
          await Promise.race([
            this.imap.idle(),
            this.sleepAbortable(this.pollInterval * 1000, signal),
          ]);
        } catch {
          await this.resetImap();
        }
        continue;
      }
      await this.sleepAbortable(this.pollInterval * 1000, signal);
    }
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async ensureImap(): Promise<ImapClientLike> {
    if (!this.imap) {
      if (!this.deps) {
        this.deps = await loadEmailDeps();
      }
      const client = this.deps.imapFactory({
        host: this.imapHost,
        port: this.imapPort,
        secure: this.imapSsl,
        auth: { user: this.username, pass: this.password },
      });
      await client.connect();
      await client.mailboxOpen(this.mailbox);
      const caps = client.capabilities;
      this.idleSupported = Boolean(caps && caps.has("IDLE"));
      this.imap = client;
    }
    return this.imap;
  }

  private async resetImap(): Promise<void> {
    const client = this.imap;
    this.imap = null;
    this.idleSupported = false;
    if (client) {
      try {
        await client.logout();
      } catch {
        try {
          client.close?.();
        } catch {
          // ignore
        }
      }
    }
  }

  private async fetchUnseen(): Promise<ParsedMailItem[]> {
    const imap = await this.ensureImap();
    const deps = this.deps!;
    const uids = await imap.search({ seen: false }, { uid: true });
    if (!uids || uids.length === 0) {
      return [];
    }
    const items: ParsedMailItem[] = [];
    const processedUids: number[] = [];
    for await (const fetched of imap.fetch(
      uids,
      { uid: true, source: true },
      { uid: true },
    )) {
      if (!fetched.source) continue;
      processedUids.push(fetched.uid);
      const parsed = await deps.parseMime(fetched.source);
      const address = String(parsed.from?.address ?? "").trim();
      if (!address) continue;
      const name = String(parsed.from?.name ?? "").trim() || address;
      const subject = String(parsed.subject ?? "");
      const messageRef =
        String(parsed.messageId ?? "").trim() || `uid-${fetched.uid}`;
      const attachments = (parsed.attachments ?? []).map(att => ({
        filename: String(att.filename ?? ""),
        contentType: String(att.mimeType || "application/octet-stream"),
        payload: toBuffer(att.content),
      }));
      items.push({
        uid: fetched.uid,
        address,
        name,
        messageRef,
        threadId: normalizeSubject(subject),
        subject,
        body: String(parsed.text ?? ""),
        attachments,
      });
    }
    if (processedUids.length > 0 && typeof imap.messageFlagsAdd === "function") {
      await imap.messageFlagsAdd(processedUids, ["\\Seen"], { uid: true }).catch(() => {});
    }
    return items;
  }

  private async deliver(item: ParsedMailItem): Promise<void> {
    const dir = ensureAttachmentDir(this.uploadsRoot, CHANNEL_ID);
    const saved: Attachment[] = [];
    for (let i = 0; i < item.attachments.length; i += 1) {
      const att = item.attachments[i]!;
      if (att.payload.byteLength > MAX_ATTACHMENT_BYTES) {
        await this.sendNotice(item.address, item.subject, OVERSIZE_NOTICE);
        continue;
      }
      const fallback = `${safeFilename(item.messageRef, "mail")}-${i + 1}.bin`;
      const dest = path.join(dir, safeFilename(att.filename, fallback));
      fs.writeFileSync(dest, att.payload);
      saved.push({
        path: dest,
        content_type: att.contentType,
        kind: attachmentKind(att.contentType),
      });
    }
    this.threadRefs.set(item.threadId, [item.messageRef, item.subject]);
    if (this.sink) {
      const inbound: InboundMessage = {
        channel: CHANNEL_ID,
        chat_id: item.address,
        chat_type: "dm",
        sender_id: item.address,
        sender_name: item.name,
        thread_id: item.threadId,
        text: item.body,
        attachments: saved,
        message_ref: item.messageRef,
      };
      await this.sink.inbound(inbound);
    }
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<void> {
    try {
      await this.sendMail(
        target.chat_id,
        target.thread_id ?? null,
        payload.text,
        payload.attachments ?? [],
      );
    } catch {
      // logged/ignored per §8
    }
  }

  private async sendMail(
    to: string,
    threadId: string | null,
    text: string,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    if (!this.deps) {
      this.deps = await loadEmailDeps();
    }
    const ref = threadId ? this.threadRefs.get(threadId) : undefined;
    const originalSubject = ref ? ref[1] : "";
    let subject = FALLBACK_SUBJECT;
    if (originalSubject) {
      subject = SUBJECT_PREFIX_RE.test(originalSubject)
        ? originalSubject
        : `Re: ${originalSubject}`;
    }
    const mailAttachments = attachments.map(att => ({
      filename: path.basename(att.path),
      content: fs.readFileSync(att.path),
      contentType: att.content_type || "application/octet-stream",
    }));
    const secure = this.smtpPort === 465 && !this.smtpStarttls;
    const transporter = this.deps.smtpFactory({
      host: this.smtpHost,
      port: this.smtpPort,
      secure,
      requireTLS: this.smtpStarttls,
      auth: { user: this.username, pass: this.password },
    });
    try {
      await transporter.sendMail({
        from: this.username,
        to,
        subject,
        ...(text ? { text } : {}),
        ...(ref ? { inReplyTo: ref[0] } : {}),
        ...(mailAttachments.length > 0 ? { attachments: mailAttachments } : {}),
      });
    } finally {
      transporter.close?.();
    }
  }

  private async sendNotice(to: string, subject: string, text: string): Promise<void> {
    const norm = normalizeSubject(subject);
    if (!this.threadRefs.has(norm) && subject) {
      this.threadRefs.set(norm, ["", subject]);
    }
    try {
      await this.sendMail(to, norm, text);
    } catch {
      // best effort
    }
  }

  async typing(_target: SendTarget): Promise<void> {
    // supports_typing is false
  }
}

export interface EmailBuildOptions {
  readonly imapFactory?: ImapFactory;
  readonly smtpTransport?: SmtpTransportLike;
  readonly smtpTransportFactory?: SmtpTransportFactory;
  readonly pollIntervalOverride?: number;
}

export async function buildChannel(
  config: ChannelConfig,
  uploadsRoot: string,
  options?: EmailBuildOptions,
): Promise<EmailChannel> {
  const extra = config.extra;
  const imapHost = String(extra.imap_host ?? "").trim();
  const smtpHost = String(extra.smtp_host ?? "").trim();
  const username = String(extra.username ?? "").trim();
  const password = String(extra.password ?? "").trim();
  const missing: string[] = [];
  if (!imapHost) missing.push("imap_host");
  if (!smtpHost) missing.push("smtp_host");
  if (!username) missing.push("username");
  if (!password) missing.push("password");
  if (missing.length > 0) {
    throw new Error(
      `channel 'email' requires non-empty ${missing.join(", ")} (channels.email.<key>)`,
    );
  }
  const deps = await loadEmailDeps(options);
  const imapSsl = extra.imap_ssl === undefined ? true : Boolean(extra.imap_ssl);
  const smtpStarttls =
    extra.smtp_starttls === undefined ? false : Boolean(extra.smtp_starttls);
  const imapPort =
    extra.imap_port !== undefined ? Number(extra.imap_port) : undefined;
  const smtpPort =
    extra.smtp_port !== undefined ? Number(extra.smtp_port) : undefined;
  const mailbox = String(extra.mailbox ?? "").trim() || DEFAULT_MAILBOX;
  const pollInterval =
    options?.pollIntervalOverride ??
    (extra.poll_interval !== undefined
      ? Number(extra.poll_interval)
      : DEFAULT_POLL_INTERVAL);

  return new EmailChannel({
    imapHost,
    imapPort,
    imapSsl,
    smtpHost,
    smtpPort,
    smtpStarttls,
    username,
    password,
    mailbox,
    pollInterval,
    uploadsRoot,
    deps,
  });
}
