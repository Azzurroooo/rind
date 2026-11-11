import test from "node:test";
import assert from "node:assert/strict";
import {
  CancellationTokenSource,
  WebSessions,
  decodeHtmlBytes,
  detectHtmlEncoding,
  fetchWebPage,
  htmlToMarkdown,
  searchWeb,
} from "../dist/index.js";

// Pre-encoded GBK bytes for "中文网页标题" and "正文内容测试"
// "中文网页标题" in GBK: D6 D0 CE C4 CD F8 D2 B3 B1 EA CC E2
// "正文内容测试" in GBK: D5 FD CE C4 C4 DA C8 DD B2 E2 CA D4
const GBK_TITLE = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xcd, 0xf8, 0xd2, 0xb3, 0xb1, 0xea, 0xcc, 0xe2]);
const GBK_BODY = Buffer.from([0xd5, 0xfd, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0xb2, 0xe2, 0xca, 0xd4]);

test("detectHtmlEncoding and decodeHtmlBytes decode GBK/GB2312 and UTF-8 accurately", () => {
  const gbkHtml = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"><title>', "ascii"),
    GBK_TITLE,
    Buffer.from("</title></head><body><main><p>", "ascii"),
    GBK_BODY,
    Buffer.from("</p></main></body></html>", "ascii"),
  ]);
  assert.equal(detectHtmlEncoding(gbkHtml, "text/html"), "gb18030");
  const decoded = decodeHtmlBytes(gbkHtml, "text/html");
  assert.match(decoded, /中文网页标题/);
  assert.match(decoded, /正文内容测试/);

  // Header Content-Type charset takes precedence
  const headerDetected = detectHtmlEncoding(GBK_BODY, "text/html; charset=GB2312");
  assert.equal(headerDetected, "gb18030");
  assert.equal(decodeHtmlBytes(GBK_BODY, "text/html; charset=GB2312"), "正文内容测试");
});

test("htmlToMarkdown strips navigation/boilerplate and preserves Markdown tables and links", () => {
  const html = `
    <html>
      <body>
        <nav><a href="/home">Nav Link</a></nav>
        <main>
          <h1>Guide</h1>
          <p>Read <a href="https://example.com/docs">Docs</a>.</p>
          <table>
            <tr><th>Name</th><th>Status</th></tr>
            <tr><td>Runtime</td><td>Ready</td></tr>
          </table>
        </main>
        <footer>Copyright 2026</footer>
      </body>
    </html>
  `;
  const md = htmlToMarkdown(html);
  assert.doesNotMatch(md, /Nav Link|Copyright/);
  assert.match(md, /# Guide/);
  assert.match(md, /\[Docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(md, /\| Name \| Status \|/);
  assert.match(md, /\| Runtime \| Ready \|/);
});

test("WebSessions reuses cookies across redirects/calls, caps idle pool, and rejects after close", async () => {
  const sessions = new WebSessions();
  const seenCookies = [];

  const fakeFetch = async (url, init = {}) => {
    const u = String(url);
    seenCookies.push({ url: u, cookie: init.headers?.Cookie || "" });
    if (u === "https://example.com/login") {
      return new Response("", {
        status: 302,
        headers: {
          Location: "/dashboard",
          "Set-Cookie": "sid=abc123; Path=/; HttpOnly",
        },
      });
    }
    if (u === "https://example.com/dashboard") {
      return new Response("<html><title>Dash</title><body><p>Authenticated content</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const first = JSON.parse(
    await fetchWebPage("https://example.com/login", null, {
      httpSessions: sessions,
      fetchImpl: fakeFetch,
    }),
  );
  assert.equal(first.ok, true);
  assert.match(first.data, /# Dash/);
  assert.match(first.data, /Authenticated content/);
  assert.equal(seenCookies[1].cookie, "sid=abc123");
  assert.equal(sessions.idleCount, 1);

  // Subsequent request reuses pooled session and its cookie jar
  await fetchWebPage("https://example.com/dashboard", null, {
    httpSessions: sessions,
    fetchImpl: fakeFetch,
  });
  assert.equal(seenCookies[2].cookie, "sid=abc123");

  await sessions.closeAsync();
  assert.equal(sessions.isClosed(), true);
  assert.equal(sessions.idleCount, 0);

  const afterClose = JSON.parse(
    await fetchWebPage("https://example.com/dashboard", null, {
      httpSessions: sessions,
      fetchImpl: fakeFetch,
    }),
  );
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.error_type, "RuntimeError");
});

test("fetchWebPage enforces redirect limit, 10 MiB streaming cap, and GBK decoding", async () => {
  // 1. TooManyRedirects
  const loopFetch = async () =>
    new Response("", { status: 302, headers: { Location: "https://example.com/loop" } });
  const redirRes = JSON.parse(await fetchWebPage("https://example.com/loop", null, { fetchImpl: loopFetch }));
  assert.equal(redirRes.error_type, "TooManyRedirects");

  // 2. Streaming > 10 MiB without Content-Length header
  const hugeStreamFetch = async () => {
    let sent = 0;
    const chunk = new Uint8Array(2 * 1024 * 1024);
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= 6) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/html" } });
  };
  const hugeRes = JSON.parse(
    await fetchWebPage("https://example.com/huge", null, { fetchImpl: hugeStreamFetch }),
  );
  assert.equal(hugeRes.error_type, "ResponseTooLarge");

  // 3. GBK response body decoded cleanly
  const gbkPage = Buffer.concat([
    Buffer.from("<html><title>", "ascii"),
    GBK_TITLE,
    Buffer.from("</title><body><p>", "ascii"),
    GBK_BODY,
    Buffer.from("</p></body></html>", "ascii"),
  ]);
  const gbkFetch = async () =>
    new Response(gbkPage, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=gbk" },
    });
  const gbkRes = JSON.parse(await fetchWebPage("https://example.com/gbk", null, { fetchImpl: gbkFetch }));
  assert.equal(gbkRes.ok, true);
  assert.match(gbkRes.data, /中文网页标题/);
  assert.match(gbkRes.data, /正文内容测试/);
});

test("searchWeb routes Chinese queries to Baidu first, falls back on engine failure, and honors cancellation", async () => {
  const calledUrls = [];
  const fakeSearchFetch = async url => {
    const u = String(url);
    calledUrls.push(u);
    if (u.includes("baidu.com")) {
      throw new Error("simulated network failure");
    }
    if (u.includes("bing.com")) {
      const html = `
        <ul>
          <li class="b_algo">
            <h2><a href="https://rindai.dev/docs">Rind 文档</a></h2>
            <div class="b_caption"><p>TypeScript 运行时说明</p></div>
          </li>
        </ul>
      `;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("", { status: 200 });
  };

  const res = JSON.parse(await searchWeb("Rind 中文测试", 3, null, { fetchImpl: fakeSearchFetch }));
  assert.equal(res.ok, true);
  assert.equal(res.meta.engine, "bing");
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].url, "https://rindai.dev/docs");
  assert.ok(calledUrls[0].includes("baidu.com"), "Chinese query should try Baidu first");
  assert.ok(calledUrls[1].includes("bing.com"), "Should fall back to Bing");

  const cts = new CancellationTokenSource();
  cts.cancel("stop");
  const cancelled = JSON.parse(await searchWeb("test", 3, cts.token, { fetchImpl: fakeSearchFetch }));
  assert.equal(cancelled.error_type, "Cancelled");
});
