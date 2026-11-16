import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import * as undici from "undici";
import { MODEL_IDLE_TIMEOUT_MS } from "./llm/sse.js";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = MODEL_IDLE_TIMEOUT_MS;
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let configured = false;

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" when a streaming response body is
// cancelled mid-flight. The reader promise still rejects cleanly; attaching a
// no-op listener prevents EventEmitter's unhandled "error" crash.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

function normalizeProxyEnv(): void {
  const allProxy = (process.env.ALL_PROXY || process.env.all_proxy || "").trim();
  if (allProxy && /^https?:\/\//i.test(allProxy)) {
    if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
      process.env.HTTP_PROXY = allProxy;
    }
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
      process.env.HTTPS_PROXY = allProxy;
    }
  }
}

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  options?: { force?: boolean },
): undici.Dispatcher {
  if (configured && !options?.force) {
    return undici.getGlobalDispatcher();
  }
  normalizeProxyEnv();
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.trunc(timeoutMs) : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      proxyTunnel: true,
      bodyTimeout: normalizedTimeout,
      headersTimeout: normalizedTimeout,
      connect: {
        autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      },
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);

  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals && typeof (undici as { install?: () => void }).install === "function") {
    (undici as { install: () => void }).install();
    installedGlobalFetch = globalThis.fetch;
  }
  configured = true;
  return dispatcher;
}

async function openSocks5Socket(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const proxyHost = proxyUrl.hostname;
  const proxyPort = Number.parseInt(proxyUrl.port || "1080", 10);
  const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : "";
  const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : "";

  const socket = net.connect({ host: proxyHost, port: proxyPort });
  socket.setNoDelay(true);

  const readExact = (n: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("SOCKS5 proxy handshake timed out."));
      }, timeoutMs);

      const onReadable = () => {
        const chunk = socket.read(n) as Buffer | null;
        if (chunk && chunk.length === n) {
          cleanup();
          resolve(chunk);
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("SOCKS5 proxy closed connection unexpectedly."));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("readable", onReadable);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.on("readable", onReadable);
      socket.once("error", onError);
      socket.once("close", onClose);
      onReadable();
    });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SOCKS5 proxy connect timed out."));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const methods = username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
  socket.write(methods);
  const greeting = await readExact(2);
  if (greeting[0] !== 0x05 || greeting[1] === 0xff) {
    socket.destroy();
    throw new Error("SOCKS5 proxy rejected authentication methods.");
  }
  if (greeting[1] === 0x02) {
    const uBuf = Buffer.from(username, "utf8");
    const pBuf = Buffer.from(password, "utf8");
    const authReq = Buffer.concat([
      Buffer.from([0x01, uBuf.length]),
      uBuf,
      Buffer.from([pBuf.length]),
      pBuf,
    ]);
    socket.write(authReq);
    const authRes = await readExact(2);
    if (authRes[1] !== 0x00) {
      socket.destroy();
      throw new Error("SOCKS5 proxy username/password authentication failed.");
    }
  } else if (greeting[1] !== 0x00) {
    socket.destroy();
    throw new Error(`Unsupported SOCKS5 auth method: ${greeting[1]}`);
  }

  const hostBuf = Buffer.from(targetHost, "utf8");
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(targetPort, 0);
  const connectReq = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    portBuf,
  ]);
  socket.write(connectReq);

  const replyHead = await readExact(4);
  if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 CONNECT failed with status 0x${replyHead[1]!.toString(16)}`);
  }
  const atyp = replyHead[3];
  if (atyp === 0x01) {
    await readExact(4 + 2);
  } else if (atyp === 0x04) {
    await readExact(16 + 2);
  } else if (atyp === 0x03) {
    const lenBuf = await readExact(1);
    await readExact(lenBuf[0]! + 2);
  } else {
    socket.destroy();
    throw new Error(`Unsupported SOCKS5 address type: ${atyp}`);
  }

  return socket;
}

export function createProxyDispatcher(
  proxyUrl: string,
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): undici.Dispatcher {
  const parsed = new URL(proxyUrl);
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") {
    return withUndiciErrorListener(
      new undici.ProxyAgent({
        uri: proxyUrl,
        proxyTunnel: true,
        allowH2: false,
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
      }),
    );
  }
  if (protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks:") {
    return withUndiciErrorListener(
      new undici.Agent({
        allowH2: false,
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        connect(opts, callback) {
          const host = opts.hostname;
          const isTls = opts.protocol === "https:";
          const port = Number.parseInt(String(opts.port || (isTls ? 443 : 80)), 10);
          openSocks5Socket(parsed, host, port)
            .then(rawSocket => {
              if (!isTls) {
                callback(null, rawSocket);
                return;
              }
              const tlsSocket = tls.connect({
                socket: rawSocket,
                servername: opts.servername || host,
              });
              tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
              tlsSocket.once("error", err => callback(err, null));
            })
            .catch(err => callback(err instanceof Error ? err : new Error(String(err)), null));
        },
      }),
    );
  }
  throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
}

export function createProxyFetch(
  proxyUrl?: string | null,
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): typeof globalThis.fetch {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return globalThis.fetch;
  }
  const dispatcher = createProxyDispatcher(trimmed, timeoutMs);
  return ((input: Parameters<typeof undici.fetch>[0], init?: Parameters<typeof undici.fetch>[1]) =>
    undici.fetch(input, {
      ...init,
      dispatcher,
    })) as unknown as typeof globalThis.fetch;
}
