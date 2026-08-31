const DEFAULT_URL = "ws://localhost:8765";

export function initialRuntimeUrl() {
  const queryUrl = new URLSearchParams(window.location.search).get("ws");
  return queryUrl || localStorage.getItem("rind.wsUrl") || import.meta.env.VITE_RIND_WS_URL || DEFAULT_URL;
}

export function createRuntimeClient({ url = DEFAULT_URL, onEvent = () => {}, onStatus = () => {}, onOpen = () => {} } = {}) {
  let socket = null;
  let closedByUser = false;
  let reconnectTimer = null;
  let nextRequestId = 1;
  let reconnectAttempt = 0;
  let connectPromise = null;
  const pending = new Map();

  function connect() {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connectPromise) return connectPromise;
    closedByUser = false;
    onStatus({ state: "connecting", url });
    connectPromise = new Promise((resolve, reject) => {
      const current = new WebSocket(url);
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
        onStatus({ state: "connected", url });
        resolve();
        void onOpen();
      });
      current.addEventListener("message", (event) => receive(event.data));
      current.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          connectPromise = null;
          reject(new Error(`Unable to connect to ${url}.`));
        }
        onStatus({ state: "error", url, message: `Unable to reach ${url}.` });
      });
      current.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          connectPromise = null;
          reject(new Error(`Connection to ${url} closed.`));
        }
        if (socket === current) socket = null;
        for (const entry of pending.values()) entry.reject(new Error("Runtime connection closed."));
        pending.clear();
        onStatus({ state: closedByUser ? "closed" : "disconnected", url });
        if (!closedByUser) scheduleReconnect();
      });
    });
    return connectPromise;
  }

  function scheduleReconnect() {
    if (reconnectTimer || closedByUser) return;
    reconnectAttempt += 1;
    const delay = Math.min(8000, 500 * 2 ** Math.min(reconnectAttempt - 1, 4));
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {});
    }, delay);
  }

  async function request(method, params = {}) {
    await connect();
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        socket.send(JSON.stringify({ kind: "request", request_id: requestId, method, params }));
      } catch (error) {
        pending.delete(requestId);
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

  function disconnect() {
    closedByUser = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const current = socket;
    socket = null;
    connectPromise = null;
    current?.close();
  }

  return {
    connect,
    request,
    disconnect,
    setUrl,
    get url() { return url; },
    get connected() { return socket?.readyState === WebSocket.OPEN; },
  };
}
