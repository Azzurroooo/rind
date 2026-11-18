import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteTextSync } from "../infrastructure/persistence/atomic-files.js";
import type { InboundMessage } from "./types.js";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export const PENDING_CAP = 3;
export const COOLDOWN_WINDOW_SECONDS = 60.0;

export const DEFAULT_BOT_HANDLES: readonly string[] = ["rind", "bot"];
export const COOLDOWN_NOTICE =
  "You're sending too fast; processing is paused — try again shortly.";
// BUG FIX 2: updated command hint to `rind gateway approve {code}`
export const APPROVE_COMMAND = "rind gateway approve {code}";
export const PAIRING_FULL_NOTICE =
  "Too many pending pairing requests; try again later.";

export function pairingNotice(
  channel: string,
  senderId: string,
  code: string,
  ttlSeconds: number,
): string {
  const minutes = Math.max(1, Math.floor(ttlSeconds / 60));
  const cmd = APPROVE_COMMAND.replace("{code}", code);
  return [
    "Rind: this account is not authorized yet.",
    `identity: ${channel} · ${senderId}`,
    `pairing code: \`${code}\``,
    `approve: run \`${cmd}\` on the server`,
    `valid for ${minutes} minutes; once it expires, messaging again issues a new code.`,
  ].join("\n");
}

export class Verdict {
  readonly allow: boolean;
  readonly pairing: boolean;
  readonly notice: string;

  constructor(allow: boolean, options?: { pairing?: boolean; notice?: string }) {
    this.allow = allow;
    this.pairing = options?.pairing ?? false;
    this.notice = options?.notice ?? "";
  }
}

export const ALLOW = new Verdict(true);
export const DENY = new Verdict(false);

export interface PendingPairingEntry {
  channel: string;
  sender_id: string;
  expires: number;
}

export class PairingStore {
  private readonly filePath: string;
  private readonly nowFn: () => number;
  pending: Record<string, PendingPairingEntry> = {};
  approved: Array<[string, string]> = [];
  private loadedMtimeMs = -1;
  private loadedSize = -1;

  constructor(filePath: string, options?: { now?: () => number }) {
    this.filePath = path.resolve(filePath);
    this.nowFn = options?.now ?? (() => Date.now() / 1000);
    this.load();
  }

  private statSignature(): { exists: boolean; mtimeMs: number; size: number } {
    try {
      const st = fs.statSync(this.filePath);
      if (!st.isFile()) {
        return { exists: false, mtimeMs: -1, size: -1 };
      }
      return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { exists: false, mtimeMs: -1, size: -1 };
    }
  }

  /**
   * BUG FIX 2: Reload pairing.json when modified externally (e.g. out-of-process
   * `rind gateway approve <CODE>`) so a live gateway honors approvals immediately.
   */
  reloadIfChanged(): void {
    const sig = this.statSignature();
    if (!sig.exists) {
      if (this.loadedMtimeMs !== -1) {
        this.loadedMtimeMs = -1;
        this.loadedSize = -1;
      }
      return;
    }
    if (sig.mtimeMs !== this.loadedMtimeMs || sig.size !== this.loadedSize) {
      this.load();
    }
  }

  load(): void {
    const sig = this.statSignature();
    if (!sig.exists) {
      this.loadedMtimeMs = -1;
      this.loadedSize = -1;
      return;
    }
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("pairing store must be an object");
      }
      const obj = data as Record<string, unknown>;
      const rawPending = obj.pending ?? {};
      const rawApproved = obj.approved ?? [];
      if (
        typeof rawPending !== "object" ||
        rawPending === null ||
        Array.isArray(rawPending) ||
        !Array.isArray(rawApproved)
      ) {
        throw new Error("invalid pairing store shape");
      }
      const nextPending: Record<string, PendingPairingEntry> = {};
      for (const [code, entry] of Object.entries(rawPending as Record<string, unknown>)) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const e = entry as Record<string, unknown>;
          nextPending[String(code)] = {
            channel: String(e.channel ?? ""),
            sender_id: String(e.sender_id ?? ""),
            expires: Number(e.expires ?? 0) || 0,
          };
        }
      }
      const nextApproved: Array<[string, string]> = [];
      for (const pair of rawApproved) {
        if (Array.isArray(pair) && pair.length >= 2) {
          nextApproved.push([String(pair[0] ?? ""), String(pair[1] ?? "")]);
        }
      }
      this.pending = nextPending;
      this.approved = nextApproved;
      const afterSig = this.statSignature();
      this.loadedMtimeMs = afterSig.mtimeMs;
      this.loadedSize = afterSig.size;
    } catch {
      const corrupt = `${this.filePath}.corrupt`;
      try {
        fs.renameSync(this.filePath, corrupt);
      } catch {
        // best effort
      }
      this.pending = {};
      this.approved = [];
      this.loadedMtimeMs = -1;
      this.loadedSize = -1;
    }
  }

  isApproved(channel: string, senderId: string): boolean {
    this.reloadIfChanged();
    return this.approved.some(([ch, id]) => ch === channel && id === senderId);
  }

  private purgeExpired(): void {
    const now = this.nowFn();
    const kept: Record<string, PendingPairingEntry> = {};
    for (const [code, entry] of Object.entries(this.pending)) {
      if (Number(entry.expires) > now) {
        kept[code] = entry;
      }
    }
    this.pending = kept;
  }

  ensurePending(channel: string, senderId: string, ttlSeconds: number): string | null {
    this.reloadIfChanged();
    this.purgeExpired();
    for (const [code, entry] of Object.entries(this.pending)) {
      if (entry.channel === channel && entry.sender_id === senderId) {
        return code;
      }
    }
    if (Object.keys(this.pending).length >= PENDING_CAP) {
      return null;
    }
    const code = this.generateCode();
    this.pending[code] = {
      channel,
      sender_id: senderId,
      expires: this.nowFn() + ttlSeconds,
    };
    this.save();
    return code;
  }

  approve(code: string): boolean {
    this.reloadIfChanged();
    this.purgeExpired();
    const normalized = code.trim().toUpperCase();
    const entry = this.pending[normalized];
    if (!entry) {
      return false;
    }
    delete this.pending[normalized];
    const channel = String(entry.channel || "");
    const senderId = String(entry.sender_id || "");
    if (!this.approved.some(([ch, id]) => ch === channel && id === senderId)) {
      this.approved.push([channel, senderId]);
    }
    this.save();
    return true;
  }

  private generateCode(): string {
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]!;
    }
    return out;
  }

  save(): void {
    const payload = JSON.stringify(
      {
        pending: this.pending,
        approved: this.approved,
      },
      null,
      2,
    );
    atomicWriteTextSync(this.filePath, payload);
    const sig = this.statSignature();
    this.loadedMtimeMs = sig.mtimeMs;
    this.loadedSize = sig.size;
  }
}

export class CooldownGate {
  private readonly limit: number;
  private readonly windowSeconds: number;
  private readonly hits = new Map<string, number[]>();
  private readonly notified = new Set<string>();
  private lastPruneAt = 0;

  constructor(limit: number, options?: { windowSeconds?: number }) {
    this.limit = limit;
    this.windowSeconds = options?.windowSeconds ?? COOLDOWN_WINDOW_SECONDS;
  }

  admit(channel: string, senderId: string, options?: { now?: number }): Verdict {
    const moment = options?.now ?? Date.now() / 1000;
    if (this.hits.size > 256 && moment - this.lastPruneAt >= this.windowSeconds) {
      this.lastPruneAt = moment;
      const cutoff = moment - this.windowSeconds;
      for (const [k, w] of this.hits.entries()) {
        while (w.length > 0 && w[0]! <= cutoff) {
          w.shift();
        }
        if (w.length === 0) {
          this.hits.delete(k);
          this.notified.delete(k);
        }
      }
    }
    const key = `${channel}\0${senderId}`;
    let window = this.hits.get(key);
    if (!window) {
      window = [];
      this.hits.set(key, window);
    }
    while (window.length > 0 && window[0]! <= moment - this.windowSeconds) {
      window.shift();
    }
    if (window.length >= this.limit) {
      if (!this.notified.has(key)) {
        this.notified.add(key);
        return new Verdict(false, { notice: COOLDOWN_NOTICE });
      }
      return DENY;
    }
    window.push(moment);
    this.notified.delete(key);
    return ALLOW;
  }
}

const PUNCTUATION_CHARS = new Set([..."，。！？,.!?：:\"'（）()[]【】「」『』、;；"]);

function stripHandlePunctuation(token: string): string {
  const chars = [...token];
  let start = 0;
  let end = chars.length;
  while (start < end && PUNCTUATION_CHARS.has(chars[start]!)) {
    start += 1;
  }
  while (end > start && PUNCTUATION_CHARS.has(chars[end - 1]!)) {
    end -= 1;
  }
  return chars.slice(start, end).join("");
}

export function isAddressedToBot(
  message: InboundMessage,
  handles: Iterable<string> = DEFAULT_BOT_HANDLES,
): boolean {
  const normalized = new Set<string>();
  for (const h of handles) {
    normalized.add(h.toLowerCase());
  }
  for (const token of message.text.split(/[\s，。！？：；、（）【】「」『』]+/)) {
    if (!token) continue;
    const candidate = stripHandlePunctuation(token).toLowerCase();
    if (candidate.startsWith("@") && normalized.has(candidate.slice(1))) {
      return true;
    }
  }
  return false;
}

export class SecurityGate {
  private readonly pairing: PairingStore;
  private readonly cooldown: CooldownGate;
  private readonly allowFrom: Record<string, readonly string[]>;
  private readonly groupAllow: Record<string, readonly string[]>;
  private readonly pairingEnabled: boolean;
  private readonly pairingTtlSeconds: number;
  private readonly botHandles: readonly string[];

  constructor(options: {
    pairing: PairingStore;
    cooldown: CooldownGate;
    allowFrom?: Readonly<Record<string, readonly string[]>>;
    groupAllow?: Readonly<Record<string, readonly string[]>>;
    pairingEnabled?: boolean;
    pairingTtlSeconds?: number;
    botHandles?: Iterable<string>;
  }) {
    this.pairing = options.pairing;
    this.cooldown = options.cooldown;
    this.allowFrom = { ...(options.allowFrom ?? {}) };
    this.groupAllow = { ...(options.groupAllow ?? {}) };
    this.pairingEnabled = options.pairingEnabled ?? true;
    this.pairingTtlSeconds = options.pairingTtlSeconds ?? 3600.0;
    this.botHandles = options.botHandles ? [...options.botHandles] : [...DEFAULT_BOT_HANDLES];
  }

  admit(message: InboundMessage): Verdict {
    const verdict = this.admitBySource(message);
    if (!verdict.allow) {
      return verdict;
    }
    return this.cooldown.admit(message.channel, message.sender_id);
  }

  private admitBySource(message: InboundMessage): Verdict {
    if (message.chat_type !== "group") {
      return this.admitDm(message);
    }
    const allowedGroups = this.groupAllow[message.channel] ?? [];
    if (allowedGroups.includes(message.chat_id)) {
      if (isAddressedToBot(message, this.botHandles)) {
        return ALLOW;
      }
    }
    return DENY;
  }

  private admitDm(message: InboundMessage): Verdict {
    const allowedSenders = this.allowFrom[message.channel] ?? [];
    if (allowedSenders.includes(message.sender_id)) {
      return ALLOW;
    }
    if (this.pairing.isApproved(message.channel, message.sender_id)) {
      return ALLOW;
    }
    if (!this.pairingEnabled) {
      return DENY;
    }
    const code = this.pairing.ensurePending(
      message.channel,
      message.sender_id,
      this.pairingTtlSeconds,
    );
    if (code === null) {
      return new Verdict(false, { pairing: true, notice: PAIRING_FULL_NOTICE });
    }
    return new Verdict(false, {
      pairing: true,
      notice: pairingNotice(message.channel, message.sender_id, code, this.pairingTtlSeconds),
    });
  }
}
