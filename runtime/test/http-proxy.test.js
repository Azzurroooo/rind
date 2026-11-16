import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import {
  CancellationTokenSource,
  CancelledError,
  configureHttpDispatcher,
  createProxyFetch,
} from "../dist/index.js";
import { parseSseEvents } from "../dist/infrastructure/llm/sse.js";

function listenRandom(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test("configureHttpDispatcher routes via HTTP_PROXY and respects NO_PROXY", async t => {
  const targetRequests = [];
  const targetServer = http.createServer((req, res) => {
    targetRequests.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const targetPort = await listenRandom(targetServer);

  let tunnelCount = 0;
  let forwardCount = 0;
  const proxyServer = http.createServer((req, res) => {
    forwardCount += 1;
    const targetUrl = new URL(req.url);
    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: Number(targetUrl.port || 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: req.headers,
      },
      proxyRes => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    req.pipe(proxyReq);
  });
  proxyServer.on("connect", (req, clientSocket, head) => {
    tunnelCount += 1;
    const [host, portStr] = (req.url || "").split(":");
    const upstream = net.connect(Number(portStr || 80), host || "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const proxyPort = await listenRandom(proxyServer);

  const prevHttpProxy = process.env.HTTP_PROXY;
  const prevNoProxy = process.env.NO_PROXY;
  t.after(async () => {
    if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = prevHttpProxy;
    if (prevNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = prevNoProxy;
    configureHttpDispatcher(undefined, { force: true });
    await closeServer(proxyServer);
    await closeServer(targetServer);
  });

  // 1. Proxied request to 127.0.0.1 when NO_PROXY is empty
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
  process.env.NO_PROXY = "";
  configureHttpDispatcher(30_000, { force: true });

  const res1 = await fetch(`http://127.0.0.1:${targetPort}/via-proxy`);
  const json1 = await res1.json();
  assert.equal(json1.ok, true);
  assert.equal(json1.path, "/via-proxy");
  assert.ok(tunnelCount + forwardCount >= 1, "Request should traverse HTTP_PROXY");

  // 2. Bypassed when 127.0.0.1 is in NO_PROXY
  const beforeCount = tunnelCount + forwardCount;
  process.env.NO_PROXY = "127.0.0.1,localhost";
  configureHttpDispatcher(30_000, { force: true });

  const res2 = await fetch(`http://127.0.0.1:${targetPort}/direct`);
  const json2 = await res2.json();
  assert.equal(json2.path, "/direct");
  assert.equal(tunnelCount + forwardCount, beforeCount, "NO_PROXY should bypass proxy");
});

test("createProxyFetch tunnels requests over RFC 1928 socks5:// proxy and handles mid-stream SSE cancel cleanly", async t => {
  const sseServer = http.createServer((req, res) => {
    if (req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("data: first\n\n");
      // Keep stream open until client cancels
      req.on("close", () => res.end());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello-over-socks5");
  });
  const targetPort = await listenRandom(sseServer);

  let socksConnections = 0;
  const socksServer = net.createServer(socket => {
    socksConnections += 1;
    let stage = "greeting";
    let buf = Buffer.alloc(0);
    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        buf = buf.subarray(2 + nmethods);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (buf.length < 5) return;
        const atyp = buf[3];
        if (atyp !== 0x03) {
          socket.destroy();
          return;
        }
        const hostLen = buf[4];
        const total = 5 + hostLen + 2;
        if (buf.length < total) return;
        const host = buf.subarray(5, 5 + hostLen).toString("utf8");
        const port = buf.readUInt16BE(5 + hostLen);
        const rest = buf.subarray(total);
        stage = "streaming";
        const upstream = net.connect({ host, port }, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (rest.length > 0) upstream.write(rest);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      }
    });
  });
  socksServer.listen(0, "127.0.0.1");
  await once(socksServer, "listening");
  const socksPort = socksServer.address().port;

  t.after(async () => {
    await closeServer(socksServer);
    await closeServer(sseServer);
  });

  const socksFetch = createProxyFetch(`socks5://127.0.0.1:${socksPort}`, 15_000);
  const plainRes = await socksFetch(`http://127.0.0.1:${targetPort}/hello`);
  assert.equal(await plainRes.text(), "hello-over-socks5");
  assert.equal(socksConnections, 1);

  // Mid-stream SSE cancellation must reject with CancelledError and zero uncaught errors
  const cts = new CancellationTokenSource();
  const sseRes = await socksFetch(`http://127.0.0.1:${targetPort}/sse`, {
    signal: cts.token.signal,
  });
  const received = [];
  await assert.rejects(
    async () => {
      for await (const ev of parseSseEvents(sseRes, cts.token)) {
        received.push(ev.data);
        cts.cancel("user-abort");
      }
    },
    err => err instanceof CancelledError,
  );
  assert.deepEqual(received, ["first"]);
});
