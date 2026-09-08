const DEFAULT_URL = "ws://localhost:8765";
const HEARTBEAT_INTERVAL_MS = 10000; // send ping every 10s
const HEARTBEAT_TIMEOUT_MS = 15000; // no traffic for 15s → connection presumed dead
const MAX_RECONNECT_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 3; // then rest at offline until the user retries
const WS_UNAUTHORIZED = 4401;

function productionRuntimeUrl() {
  if (!import.meta.env.PROD || !window.location.host) return DEFAULT_URL;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function initialRuntimeUrl() {
  const queryUrl = new URLSearchParams(window.location.search).get("ws");
  return queryUrl || localStorage.getItem("rind.wsUrl") || import.meta.env.VITE_RIND_WS_URL || productionRuntimeUrl();
}

export function isAuthError(error) {
  return Number(error?.status) === 401 || Number(error?.status) === 403 || error?.code === "auth_required";
}

// Appends a credential query string (e.g. "ticket=…" or "token=…") to the WS URL.
export function withQuery(url, credential) {
  const clean = String(credential || "").trim();
  if (!clean) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${clean}`;
}

export function createRuntimeClient({ url = productionRuntimeUrl(), credentialProvider = null, onEvent = () => {}, onStatus = () => {}, onOpen = () => {} } = {}) {
  let socket = null;
  let closedByUser = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let heartbeatSeq = 0;
  let lastAliveAt = 0;
  let nextRequestId = 1;
  let reconnectAttempt = 0;
  let connectPromise = null;
  let credential = credentialProvider;
  const pending = new Map();

  async function resolveTargetUrl() {
    if (!credential) return url;
    const value = await credential();
    return withQuery(url, value);
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connectPromise) return connectPromise;
    closedByUser = false;
    onStatus({ state: "connecting", url });
    connectPromise = resolveTargetUrl()
      .catch((error) => {
        connectPromise = null;
        throw error;
      })
      .then((targetUrl) => new Promise((resolve, reject) => {
        let current;
        try {
          current = new WebSocket(targetUrl);
        } catch (error) {
          connectPromise = null;
          reject(error instanceof Error ? error : new Error(`Invalid runtime URL: ${targetUrl}`));
          return;
        }
        socket = current;
        let settled = false;
        current.addEventListener("open", () => {
          if (closedByUser || socket !== current) {
            current.close();
            return;
          }
          settled = true;
          connectPromise = null;
          reconnectAttempt = 0;
          startHeartbeat(current);
          onStatus({ state: "connected", url });
          resolve();
          void onOpen();
        });
        current.addEventListener("message", (event) => {
          lastAliveAt = Date.now();
          receive(event.data);
        });
        current.addEventListener("error", () => {
          if (!settled) {
            settled = true;
            connectPromise = null;
            reject(new Error(`Unable to connect to ${url}.`));
          }
          onStatus({ state: "error", url, message: `Unable to reach ${url}.` });
        });
        current.addEventListener("close", (event) => {
          stopHeartbeat();
          if (!settled) {
            settled = true;
            connectPromise = null;
            reject(new Error(`Connection to ${url} closed.`));
          }
          if (socket === current) socket = null;
          for (const entry of pending.values()) {
            clearRequestTimeout(entry);
            entry.reject(new Error("Runtime connection closed."));
          }
          pending.clear();
          if (event.code === WS_UNAUTHORIZED) {
            // Credential rejected: reconnecting cannot succeed; surface to login.
            onStatus({ state: "unauthorized", url, code: event.code });
            return;
          }
          onStatus({ state: closedByUser ? "closed" : "disconnected", url });
          if (!closedByUser) scheduleReconnect();
        });
      }));
    return connectPromise;
  }

  // Any inbound message (event or response, even a MethodNotFound error for the
  // ping itself) proves liveness. Silence beyond HEARTBEAT_TIMEOUT_MS kills the
  // socket so the normal close/reconnect path takes over.
  function startHeartbeat(activeSocket) {
    stopHeartbeat();
    lastAliveAt = Date.now();
    heartbeatTimer = window.setInterval(() => {
      if (socket !== activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        stopHeartbeat();
        return;
      }
      if (Date.now() - lastAliveAt > HEARTBEAT_TIMEOUT_MS) {
        onStatus({ state: "heartbeat_timeout", url });
        try {
          activeSocket.close();
        } catch {
          // closing is best-effort; the close handler does the cleanup
        }
        return;
      }
      heartbeatSeq += 1;
      try {
        activeSocket.send(JSON.stringify({ kind: "request", request_id: `hb-${heartbeatSeq}`, method: "ping", params: {} }));
      } catch {
        // send failure surfaces via the close handler
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || closedByUser) return;
    // Unbounded retries would flap the UI's offline/reconnecting phases forever
    // on a dead worker; after MAX_RECONNECT_ATTEMPTS the strip rests at
    // 已断开 + 重试 and a successful connect resets the counter.
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      onStatus({ state: "disconnected", url });
      return;
    }
    reconnectAttempt += 1;
    onStatus({ state: "reconnecting", url, attempt: reconnectAttempt });
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(reconnectAttempt - 1, 4));
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => {
        if (isAuthError(error)) {
          onStatus({ state: "unauthorized", url });
          disconnect();
          return;
        }
        scheduleReconnect();
      });
    }, delay);
  }

  async function request(method, params = {}, timeoutMs = 0) {
    await connect();
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = window.setTimeout(() => {
          if (pending.delete(requestId)) reject(new Error(`Runtime request timed out: ${method}`));
        }, timeoutMs);
      }
      pending.set(requestId, entry);
      try {
        socket.send(JSON.stringify({ kind: "request", request_id: requestId, method, params }));
      } catch (error) {
        pending.delete(requestId);
        clearRequestTimeout(entry);
        reject(error);
      }
    });
  }

  function receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.kind === "event") {
      onEvent(message);
      return;
    }
    if (message?.kind !== "response") return;
    const requestId = message.request_id;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearRequestTimeout(entry);
    if (message.error) {
      const error = new Error(message.error.message || "Runtime request failed.");
      error.type = message.error.type;
      entry.reject(error);
      return;
    }
    entry.resolve(message.result);
  }

  function setUrl(nextUrl) {
    const clean = String(nextUrl || "").trim();
    if (!clean || clean === url) return;
    url = clean;
    localStorage.setItem("rind.wsUrl", clean);
    disconnect();
    closedByUser = false;
    connect().catch(() => {});
  }

  function setCredentialProvider(provider) {
    credential = typeof provider === "function" ? provider : null;
  }

  function disconnect() {
    closedByUser = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    const current = socket;
    socket = null;
    connectPromise = null;
    current?.close();
  }

  function clearRequestTimeout(entry) {
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  return {
    connect,
    request,
    disconnect,
    setUrl,
    setCredentialProvider,
    get url() { return url; },
    get connected() { return socket?.readyState === WebSocket.OPEN; },
  };
}
