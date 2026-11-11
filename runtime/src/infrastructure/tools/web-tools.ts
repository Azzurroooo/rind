import type { CancellationToken } from "../../domain/cancellation.js";
import { toolCancelled, toolError, toolOk } from "../../domain/models.js";
import { DEFAULT_USER_AGENT } from "../settings.js";
import { ToolSpec } from "./registry.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface WebSessionHandle {
  cookieHeader(url: string | URL): string | undefined;
  storeCookies(url: string | URL, headers: Headers): void;
  close(): void;
}

class InMemoryWebSession implements WebSessionHandle {
  // host -> cookieName -> cookieValue
  private readonly cookies = new Map<string, Map<string, string>>();

  cookieHeader(url: string | URL): string | undefined {
    const host = (typeof url === "string" ? new URL(url) : url).hostname.toLowerCase();
    const pairs: string[] = [];
    for (const [domain, jar] of this.cookies) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        for (const [name, val] of jar) {
          pairs.push(`${name}=${val}`);
        }
      }
    }
    return pairs.length > 0 ? pairs.join("; ") : undefined;
  }

  storeCookies(url: string | URL, headers: Headers): void {
    const parsedUrl = typeof url === "string" ? new URL(url) : url;
    const rawSetCookies =
      typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")!]
          : [];
    for (const raw of rawSetCookies) {
      const segments = raw.split(";").map(s => s.trim()).filter(Boolean);
      if (segments.length === 0) continue;
      const eqIdx = segments[0]!.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = segments[0]!.slice(0, eqIdx).trim();
      const value = segments[0]!.slice(eqIdx + 1).trim();
      let domain = parsedUrl.hostname.toLowerCase();
      let expired = false;
      for (const attr of segments.slice(1)) {
        const lower = attr.toLowerCase();
        if (lower.startsWith("domain=")) {
          const rawDom = attr.slice(7).trim().replace(/^\.+/, "").toLowerCase();
          if (rawDom && (domain === rawDom || domain.endsWith(`.${rawDom}`))) {
            domain = rawDom;
          }
        } else if (lower.startsWith("max-age=")) {
          const sec = Number.parseInt(attr.slice(8).trim(), 10);
          if (Number.isFinite(sec) && sec <= 0) {
            expired = true;
          }
        }
      }
      let jar = this.cookies.get(domain);
      if (!jar) {
        jar = new Map();
        this.cookies.set(domain, jar);
      }
      if (expired || !value) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }
  }

  close(): void {
    this.cookies.clear();
  }
}

export class WebSessions {
  static readonly MAX_IDLE_SESSIONS = 4;
  static readonly CLOSE_TIMEOUT_MS = 5_000;

  private readonly idle: WebSessionHandle[] = [];
  private active = 0;
  private closed = false;
  private drainWaiters: Array<() => void> = [];

  isClosed(): boolean {
    return this.closed;
  }

  get activeCount(): number {
    return this.active;
  }

  get idleCount(): number {
    return this.idle.length;
  }

  async withSession<T>(fn: (session: WebSessionHandle) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("Web sessions are closed.");
    }
    const session = this.idle.pop() ?? new InMemoryWebSession();
    this.active += 1;
    try {
      return await fn(session);
    } finally {
      this.active -= 1;
      if (this.closed || this.idle.length >= WebSessions.MAX_IDLE_SESSIONS) {
        session.close();
      } else {
        this.idle.push(session);
      }
      if (this.active === 0 && this.drainWaiters.length > 0) {
        for (const notify of this.drainWaiters.splice(0)) {
          notify();
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const session of this.idle.splice(0)) {
      session.close();
    }
  }

  async closeAsync(timeoutMs = WebSessions.CLOSE_TIMEOUT_MS): Promise<void> {
    this.close();
    if (this.active === 0) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      this.drainWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function detectHtmlEncoding(rawBytes: Buffer, contentTypeHeader?: string | null): string {
  if (rawBytes.length >= 3 && rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
    return "utf-8";
  }
  if (contentTypeHeader) {
    const headerMatch = /charset\s*=\s*["']?([A-Za-z0-9._\-]+)["']?/i.exec(contentTypeHeader);
    if (headerMatch?.[1]) {
      return normalizeEncodingLabel(headerMatch[1]);
    }
  }
  const headAscii = rawBytes.subarray(0, Math.min(rawBytes.length, 4096)).toString("latin1");
  const metaCharset =
    /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._\-]+)\s*["']?/i.exec(headAscii) ||
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([A-Za-z0-9._\-]+)[^"']*["']/i.exec(headAscii);
  if (metaCharset?.[1]) {
    return normalizeEncodingLabel(metaCharset[1]);
  }
  return "utf-8";
}

function normalizeEncodingLabel(label: string): string {
  const clean = label.trim().toLowerCase();
  if (clean === "gb2312" || clean === "gbk" || clean === "cp936") {
    return "gb18030";
  }
  if (clean === "utf8") {
    return "utf-8";
  }
  return clean;
}

export function decodeHtmlBytes(rawBytes: Buffer, contentTypeHeader?: string | null): string {
  const encoding = detectHtmlEncoding(rawBytes, contentTypeHeader);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(rawBytes);
  } catch {
    return rawBytes.toString("utf8");
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function stripTags(html: string, separator = ""): string {
  const withoutScripts = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const replaced = separator
    ? withoutScripts.replace(/<[^>]+>/g, separator)
    : withoutScripts.replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(replaced).replace(/[ \t]+/g, " ").trim();
}

function renderHtmlTable(tableHtml: string): string {
  const rows: string[][] = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(trMatch[1]!)) !== null) {
      cells.push(stripTags(cellMatch[2]!, " ").replace(/\|/g, "\\|"));
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map(r => r.length));
  const padRow = (r: string[]) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push("");
    return `| ${padded.join(" | ")} |`;
  };
  const header = padRow(rows[0]!);
  const divider = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
  const body = rows.slice(1).map(padRow);
  return `\n\n${[header, divider, ...body].join("\n")}\n\n`;
}

export function htmlToMarkdown(html: string): string {
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|nav|footer|header|svg|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, "");

  const mainMatch =
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned) ||
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned) ||
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned);
  if (mainMatch?.[1]) {
    cleaned = mainMatch[1];
  }

  cleaned = cleaned
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => renderHtmlTable(inner))
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n\n# ${stripTags(inner)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `\n\n## ${stripTags(inner)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `\n\n### ${stripTags(inner)}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) => `\n\n#### ${stripTags(inner)}\n\n`)
    .replace(
      /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
      (_, inner) => `\n\n\`\`\`\n${decodeHtmlEntities(inner.replace(/<[^>]+>/g, ""))}\n\`\`\`\n\n`,
    )
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner)}\``)
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = stripTags(text);
      return label ? `[${label}](${href})` : href;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}`)
    .replace(/<(p|div|section|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|tr|table|ul|ol)>/gi, "\n");

  const plain = decodeHtmlEntities(cleaned.replace(/<[^>]+>/g, ""));
  return plain
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseBingHtml(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const itemRegex = /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) !== null && results.length < maxResults) {
    const block = match[1]!;
    const h2Match = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!h2Match) continue;
    const linkMatch = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(h2Match[1]!);
    if (!linkMatch) continue;
    const url = decodeHtmlEntities(linkMatch[1]!).trim();
    const title = stripTags(linkMatch[2]!);
    let snippet = "";
    const captionMatch = /<div[^>]*class=["'][^"']*\bb_caption\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
    if (captionMatch) {
      const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(captionMatch[1]!);
      snippet = stripTags(pMatch ? pMatch[1]! : captionMatch[1]!);
    }
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function parseBaiduHtml(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const containerRegex =
    /<div[^>]*class=["'][^"']*\bc-container\b[^"']*["']([^>]*)>([\s\S]*?)(?=<div[^>]*class=["'][^"']*\bc-container\b|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = containerRegex.exec(html)) !== null && results.length < maxResults) {
    const attrs = match[1] || "";
    const block = match[2] || "";
    const h3Match = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    if (!h3Match) continue;
    const linkMatch = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(h3Match[1]!);
    if (!linkMatch) continue;
    let href = decodeHtmlEntities(linkMatch[1]!).trim();
    const title = stripTags(linkMatch[2]!);
    if (!title) continue;
    const muMatch = /\bmu=["']([^"']+)["']/i.exec(attrs);
    const mu = muMatch ? decodeHtmlEntities(muMatch[1]!).trim() : "";
    if (!href || href.startsWith("/")) {
      if (mu && mu.startsWith("http")) {
        href = mu;
      } else {
        continue;
      }
    } else if ((href.includes("baidu.com/link") || href.includes("baidu.com/baidu.php")) && mu.startsWith("http")) {
      href = mu;
    }
    let snippet = "";
    const absMatch =
      /<[^>]*class=["'][^"']*(?:c-abstract|content-right_8Zs40|c-span-last)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
        block,
      );
    if (absMatch) {
      snippet = stripTags(absMatch[1]!);
    } else {
      const text = stripTags(block);
      if (text.length > title.length + 20) {
        snippet = text.replace(title, "").trim().slice(0, 200);
      }
    }
    results.push({ title, url: href, snippet });
  }
  return results;
}

function parseDdgHtml(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRegex = /<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const url = decodeHtmlEntities(match[1]!).trim();
    const title = stripTags(match[2]!);
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 1500);
    const snippetMatch = /<a[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(after);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]!) : "";
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function clampSearchResults(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(parsed, 10));
}

function createTimeoutSignal(cancellationToken: CancellationToken | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return cancellationToken ? AbortSignal.any([cancellationToken.signal, timeoutSignal]) : timeoutSignal;
}

export async function searchWeb(
  query: string,
  maxResults = 5,
  cancellationToken?: CancellationToken | null,
  options?: { httpSessions?: WebSessions; fetchImpl?: typeof globalThis.fetch },
): Promise<string> {
  if (cancellationToken?.isCancelled) {
    return toolCancelled("search_web", cancellationToken.reason);
  }
  const sessions = options?.httpSessions ?? new WebSessions();
  if (sessions.isClosed()) {
    return toolError("search_web", "Web sessions are closed.", "RuntimeError");
  }
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) {
    return toolError("search_web", "query is required.", "ValidationError");
  }
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const limit = clampSearchResults(maxResults);
  const errors: string[] = [];
  const hasChinese = /[\u4e00-\u9fff]/.test(cleanQuery);

  return await sessions.withSession(async session => {
    const fetchHtml = async (targetUrl: string, init: RequestInit): Promise<string> => {
      const headers = new Headers(init.headers);
      const cookie = session.cookieHeader(targetUrl);
      if (cookie && !headers.has("Cookie")) {
        headers.set("Cookie", cookie);
      }
      const res = await fetchFn(targetUrl, { ...init, headers });
      session.storeCookies(targetUrl, res.headers);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      return decodeHtmlBytes(raw, res.headers.get("content-type"));
    };

    const searchBing = async (): Promise<Array<{ title: string; url: string; snippet: string }>> => {
      const url = new URL("https://cn.bing.com/search");
      url.searchParams.set("q", cleanQuery);
      url.searchParams.set("count", String(limit));
      const html = await fetchHtml(url.toString(), {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        },
        signal: createTimeoutSignal(cancellationToken, 10000),
      });
      return parseBingHtml(html, limit);
    };

    const searchBaidu = async (): Promise<Array<{ title: string; url: string; snippet: string }>> => {
      const url = new URL("https://www.baidu.com/s");
      url.searchParams.set("wd", cleanQuery);
      url.searchParams.set("rn", String(Math.min(limit, 10)));
      const html = await fetchHtml(url.toString(), {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        },
        signal: createTimeoutSignal(cancellationToken, 10000),
      });
      return parseBaiduHtml(html, limit);
    };

    const searchDdg = async (): Promise<Array<{ title: string; url: string; snippet: string }>> => {
      const body = new URLSearchParams({ q: cleanQuery });
      const html = await fetchHtml("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml",
          Referer: "https://html.duckduckgo.com/",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: createTimeoutSignal(cancellationToken, 10000),
      });
      return parseDdgHtml(html, limit);
    };

    const engines: Array<[string, () => Promise<Array<{ title: string; url: string; snippet: string }>>]> =
      hasChinese
        ? [
            ["baidu", searchBaidu],
            ["bing", searchBing],
            ["ddg", searchDdg],
          ]
        : [
            ["bing", searchBing],
            ["baidu", searchBaidu],
            ["ddg", searchDdg],
          ];

    for (const [name, fn] of engines) {
      if (cancellationToken?.isCancelled) {
        return toolCancelled("search_web", cancellationToken.reason);
      }
      try {
        const results = await fn();
        if (cancellationToken?.isCancelled) {
          return toolCancelled("search_web", cancellationToken.reason);
        }
        if (results.length > 0) {
          return toolOk("search_web", results, {
            engine: name,
            query: cleanQuery,
            matches: results.length,
          });
        }
      } catch (exc) {
        errors.push(`${name}: ${(exc as Error).message || String(exc)}`);
      }
    }

    return toolOk("search_web", [], {
      engine: "none",
      query: cleanQuery,
      errors,
      matches: 0,
    });
  });
}

export async function fetchWebPage(
  url: string,
  cancellationToken?: CancellationToken | null,
  options?: { httpSessions?: WebSessions; fetchImpl?: typeof globalThis.fetch },
): Promise<string> {
  try {
    if (cancellationToken?.isCancelled) {
      return toolCancelled("fetch_web_page", cancellationToken.reason);
    }
    const sessions = options?.httpSessions ?? new WebSessions();
    if (sessions.isClosed()) {
      return toolError("fetch_web_page", "Web sessions are closed.", "RuntimeError", { url });
    }
    const fetchFn = options?.fetchImpl ?? globalThis.fetch;

    return await sessions.withSession(async session => {
      let currentUrl = url;
      let finalResponse: Response | null = null;
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        if (cancellationToken?.isCancelled) {
          return toolCancelled("fetch_web_page", cancellationToken.reason);
        }
        const reqHeaders: Record<string, string> = {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        };
        const cookie = session.cookieHeader(currentUrl);
        if (cookie) {
          reqHeaders.Cookie = cookie;
        }
        const response = await fetchFn(currentUrl, {
          headers: reqHeaders,
          redirect: "manual",
          signal: createTimeoutSignal(cancellationToken, 15000),
        });
        session.storeCookies(currentUrl, response.headers);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirectCount >= MAX_REDIRECTS) {
            return toolError("fetch_web_page", "Too many redirects", "TooManyRedirects", { url });
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get("content-length");
        if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
          return toolError(
            "fetch_web_page",
            "Response body exceeds the 10 MiB network limit.",
            "ResponseTooLarge",
            { url, max_bytes: MAX_RESPONSE_BYTES },
          );
        }

        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            if (cancellationToken?.isCancelled) {
              await reader.cancel();
              return toolCancelled("fetch_web_page", cancellationToken.reason);
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                return toolError(
                  "fetch_web_page",
                  "Response body exceeds the 10 MiB network limit.",
                  "ResponseTooLarge",
                  { url, max_bytes: MAX_RESPONSE_BYTES },
                );
              }
              chunks.push(Buffer.from(value));
            }
          }
        }
        finalResponse = response;
        break;
      }

      if (!finalResponse) {
        return toolError("fetch_web_page", "Unable to fetch response", "FetchError", { url });
      }
      if (cancellationToken?.isCancelled) {
        return toolCancelled("fetch_web_page", cancellationToken.reason);
      }

      const rawBytes = Buffer.concat(chunks);
      if (rawBytes.length === 0) {
        return toolError("fetch_web_page", "Empty response from server", "EmptyResponse", { url });
      }
      const html = decodeHtmlBytes(rawBytes, finalResponse.headers.get("content-type"));
      if (!html.trim()) {
        return toolError("fetch_web_page", "Empty response from server", "EmptyResponse", { url });
      }

      let content = htmlToMarkdown(html);
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      const title = titleMatch ? stripTags(titleMatch[1]!, " ") : "";
      if (title && !content.includes(title)) {
        content = content ? `# ${title}\n\n${content}` : `# ${title}`;
      }

      return toolOk("fetch_web_page", content, { url });
    });
  } catch (exc) {
    if (cancellationToken?.isCancelled) {
      return toolCancelled("fetch_web_page", cancellationToken.reason);
    }
    const err = exc instanceof Error ? exc : new Error(String(exc));
    return toolError("fetch_web_page", `Fetch error: ${err.message}`, err.name || "Error", { url });
  }
}

export function buildWebToolSpecs(httpSessions: WebSessions): ToolSpec[] {
  return [
    new ToolSpec({
      name: "search_web",
      description:
        "Search the internet. Automatically switches between search engines (Bing/Baidu/DDG); works for both English and Chinese queries and is reachable from mainland China.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords (English or Chinese)" },
          max_results: {
            type: "integer",
            default: 5,
            description: "Maximum number of results (default 5)",
          },
        },
        required: ["query"],
      },
      handler: async args =>
        await searchWeb(
          args.query as string,
          (args.max_results as number | undefined) ?? 5,
          (args._cancellation_token as CancellationToken | null | undefined) ?? null,
          { httpSessions },
        ),
    }),
    new ToolSpec({
      name: "fetch_web_page",
      description:
        "Fetch a web page and extract its main content (navigation, ads, and other clutter removed; outputs Markdown). Typically used after search_web returns URLs.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Web page URL" },
        },
        required: ["url"],
      },
      handler: async args =>
        await fetchWebPage(
          args.url as string,
          (args._cancellation_token as CancellationToken | null | undefined) ?? null,
          { httpSessions },
        ),
    }),
  ];
}
