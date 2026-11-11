import readline from "node:readline";
import { Readable } from "node:stream";
import { allGuides } from "./onboarding.js";

export class WizardCancelled extends Error {
  constructor() {
    super("Wizard cancelled");
    this.name = "WizardCancelled";
  }
}

export interface PromptIO {
  readonly stdin?: Readable | string;
  readonly write?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

export class PromptSession {
  private readonly writeFn: (text: string) => void;
  private readonly writeErrFn: (text: string) => void;
  private readonly rl: readline.Interface | null;
  private readonly lines: string[] = [];
  private readonly waiters: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;

  constructor(io?: PromptIO) {
    this.writeFn = io?.write ?? (text => process.stdout.write(text));
    this.writeErrFn = io?.writeErr ?? (text => process.stderr.write(text));

    if (typeof io?.stdin === "string") {
      this.rl = null;
      if (io.stdin.length > 0) {
        const parts = io.stdin.replace(/\r\n/g, "\n").split("\n");
        if (io.stdin.endsWith("\n") || io.stdin.endsWith("\r\n")) {
          parts.pop();
        }
        this.lines.push(...parts);
      }
      this.closed = true;
      return;
    }

    const input = io?.stdin ?? process.stdin;
    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });
    this.rl = rl;
    rl.on("line", line => {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    rl.on("close", () => {
      this.closed = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        waiter.reject(new WizardCancelled());
      }
    });
  }

  println(line = ""): void {
    this.writeFn(`${line}\n`);
  }

  printerr(line = ""): void {
    this.writeErrFn(`${line}\n`);
  }

  close(): void {
    if (this.rl) {
      this.rl.close();
    }
    this.closed = true;
  }

  async inputLine(prompt = ""): Promise<string> {
    if (prompt) {
      this.writeFn(prompt);
    }
    if (this.lines.length > 0) {
      return this.lines.shift()!;
    }
    if (this.closed) {
      throw new WizardCancelled();
    }
    return await new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async ask(
    label: string,
    defaultValue = "",
    _options?: { secret?: boolean },
  ): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const raw = await this.inputLine(`${label}${suffix}: `);
    return raw.trim() || defaultValue;
  }

  async askList(label: string): Promise<string[]> {
    const raw = (
      await this.inputLine(`${label} (comma-separated, may be empty): `)
    ).trim();
    return raw
      .replace(/，/g, ",")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
  }

  async confirm(label: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? "Y/n" : "y/N";
    const raw = (await this.inputLine(`${label} [${hint}]: `)).trim().toLowerCase();
    if (!raw) {
      return defaultYes;
    }
    return raw === "y" || raw === "yes";
  }

  async pickChannels(): Promise<string[]> {
    const guides = allGuides();
    this.println(
      "\nAvailable channels (Enter = Telegram + Email, the two zero-setup channels):",
    );
    guides.forEach((guide, index) => {
      this.println(`  ${index + 1}. ${guide.emoji} ${guide.label} — ${guide.summary}`);
    });
    const raw = (
      await this.inputLine("Channel numbers (comma-separated, e.g. 1,4): ")
    ).trim();
    if (!raw) {
      return ["telegram", "email"];
    }
    const picked: string[] = [];
    for (const token of raw.replace(/，/g, ",").split(",")) {
      const trimmed = token.trim();
      if (/^\d+$/.test(trimmed)) {
        const idx = Number.parseInt(trimmed, 10);
        if (idx >= 1 && idx <= guides.length) {
          picked.push(guides[idx - 1]!.id);
        }
      }
    }
    return picked.length > 0 ? picked : ["telegram", "email"];
  }
}
