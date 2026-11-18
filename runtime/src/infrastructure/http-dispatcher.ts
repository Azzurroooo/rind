import { EventEmitter } from "node:events";
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
