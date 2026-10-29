import type { CancellationToken } from "../../domain/cancellation.js";
import { toolCancelled, toolError, toolOk } from "../../domain/models.js";
import { DEFAULT_USER_AGENT } from "../settings.js";
import { ToolSpec } from "./registry.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class WebSessions {
  private closed = false;

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
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

function htmlToMarkdown(html: string): string {
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
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n\n# ${stripTags(inner)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `\n\n## ${stripTags(inner)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `\n\n### ${stripTags(inner)}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) => `\n\n#### ${stripTags(inner)}\n\n`)
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, inner) => `\n\n\`\`\`\n${decodeHtmlEntities(inner.replace(/<[^>]+>/g, ""))}\n\`\`\`\n\n`)
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
  const containerRegex = /<div[^>]*class=["'][^"']*\bc-container\b[^"']*["']([^>]*)>([\s\S]*?)(?=<div[^>]*class=["'][^"']*\bc-container\b|$)/gi;
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
    const absMatch = /<[^>]*class=["'][^"']*(?:c-abstract|content-right_8Zs40|c-span-last)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
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

export async function searchWeb(
  query: string,
  maxResults = 5,
  cancellationToken?: CancellationToken | null,
  options?: { httpSessions?: WebSessions },
): Promise<string> {
  if (cancellationToken?.isCancelled) {
    return toolCancelled("search_web", cancellationToken.reason);
  }
  if (options?.httpSessions?.isClosed()) {
    return toolError("search_web", "Web sessions are closed.", "RuntimeError");
  }
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) {
    return toolError("search_web", "query is required.", "ValidationError");
  }
  const limit = clampSearchResults(maxResults);
  const errors: string[] = [];
  const hasChinese = /[\u4e00-\u9fff]/.test(cleanQuery);

  const searchBing = async (): Promise<Array<{ title: string; url: string; snippet: string }>> => {
    const url = new URL("https://cn.bing.com/search");
    url.searchParams.set("q", cleanQuery);
    url.searchParams.set("count", String(limit));
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
      signal: cancellationToken?.signal ?? AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseBingHtml(await res.text(), limit);
  };

  const searchBaidu = async (): Promise<Array<{ title: string; url: string; snippet: string }>> => {
    const url = new URL("https://www.baidu.com/s");
    url.searchParams.set("wd", cleanQuery);
    url.searchParams.set("rn", String(Math.min(limit, 10)));
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
      signal: cancellationToken?.signal ?? AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseBaiduHtml(await res.text(), limit);
  };

  const searchDdg = async (): Promise<Array<{ title: string; url: string; snippet: string }>> => {
    const body = new URLSearchParams({ q: cleanQuery });
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://html.duckduckgo.com/",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: cancellationToken?.signal ?? AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDdgHtml(await res.text(), limit);
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
}

export async function fetchWebPage(
  url: string,
  cancellationToken?: CancellationToken | null,
  options?: { httpSessions?: WebSessions },
): Promise<string> {
  try {
    if (cancellationToken?.isCancelled) {
      return toolCancelled("fetch_web_page", cancellationToken.reason);
    }
    if (options?.httpSessions?.isClosed()) {
      return toolError("fetch_web_page", "Web sessions are closed.", "RuntimeError", { url });
    }
    let currentUrl = url;
    let finalResponse: Response | null = null;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      if (cancellationToken?.isCancelled) {
        return toolCancelled("fetch_web_page", cancellationToken.reason);
      }
      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "manual",
        signal: cancellationToken?.signal ?? AbortSignal.timeout(15000),
      });

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

    const html = Buffer.concat(chunks).toString("utf8");
    if (!html) {
      return toolError("fetch_web_page", "Empty response from server", "EmptyResponse", { url });
    }

    let content = htmlToMarkdown(html);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleMatch ? stripTags(titleMatch[1]!, " ") : "";
    if (title && !content.includes(title)) {
      content = content ? `# ${title}\n\n${content}` : `# ${title}`;
    }

    return toolOk("fetch_web_page", content, { url });
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
