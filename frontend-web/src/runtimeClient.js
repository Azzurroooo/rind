const WS_UNAUTHORIZED = 4401;
const LONG_REQUESTS = new Set(["session/prompt", "rind/session/compact", "rind/command/execute"]);

function defaultUrl() {
  return window.location.host ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws` : "ws://localhost:8765";
}

export function initialRuntimeUrl() {
  // Deployment configuration is explicit. Links and stale browser preferences
  // cannot redirect a paired device to an unrelated server.
  return import.meta.env.VITE_RIND_WS_URL || defaultUrl();
}

export function isAuthError(error) {
  return [401, 403].includes(Number(error?.status)) || error?.code === "auth_required";
}

export function withQuery(url, credential) {
  const clean = String(credential || "").trim();
  return clean ? `${url}${url.includes("?") ? "&" : "?"}${clean}` : url;
}

export function createRuntimeClient({ url = defaultUrl(), credentialProvider = null, onEvent = () => {}, onStatus = () => {}, onOpen = () => {} } = {}) {
  let socket = null;
  let generation = 0;
  let stopped = true;
  let connecting = null;
  let cancelConnect = null;
  let reconnectTimer;
  let heartbeatTimer;
  let attempt = 0;
  let nextId = 1;
  let credential = credentialProvider;
  const pending = new Map();

  function rejectPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Runtime connection closed.")); }
    pending.clear();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    onStatus({ state: "reconnecting", url, attempt: ++attempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => {});
    }, Math.min(8000, 500 * 2 ** Math.min(attempt - 1, 4)));
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connecting) return connecting;
    stopped = false;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const currentGeneration = ++generation;
    const isCurrent = () => generation === currentGeneration && !stopped;
    onStatus({ state: "connecting", url });
    connecting = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(deadline);
        if (generation === currentGeneration) { connecting = null; cancelConnect = null; }
        if (error) reject(error); else resolve();
      };
      const fail = (error) => {
        if (!isCurrent()) return;
        finish(error);
        clearInterval(heartbeatTimer); rejectPending();
        const failedSocket = socket; socket = null;
        ++generation;
        failedSocket?.close();
        if (isAuthError(error)) { stopped = true; onStatus({ state: "unauthorized", url }); }
        else { onStatus({ state: "disconnected", url, message: error.message }); scheduleReconnect(); }
      };
      const deadline = setTimeout(() => {
        if (!isCurrent()) return;
        fail(new Error("Connection timed out."));
      }, 12000);
      cancelConnect = () => finish(new Error("Connection cancelled."));
      Promise.resolve().then(() => credential?.(url)).then((value) => {
        if (!isCurrent()) return;
        const current = new WebSocket(withQuery(url, value));
        socket = current;
        let lastAliveAt = Date.now();
        current.addEventListener("open", () => {
          if (!isCurrent()) { current.close(); return; }
          finish(); attempt = 0;
          onStatus({ state: "connected", url });
          clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (!isCurrent()) return;
            if (Date.now() - lastAliveAt > 25000) { current.close(); return; }
            if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ kind: "request", request_id: `hb-${nextId++}`, method: "ping", params: {} }));
          }, 10000);
          Promise.resolve().then(onOpen).catch((error) => {
            if (!isCurrent()) return;
            onStatus({ state: "error", url, message: error.message }); current.close();
          });
        });
        current.addEventListener("message", (event) => {
          if (!isCurrent()) return;
          lastAliveAt = Date.now();
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message?.kind === "event") { onEvent(message); return; }
          if (message?.kind !== "response") return;
          const entry = pending.get(message.request_id);
          if (!entry) return;
          pending.delete(message.request_id); clearTimeout(entry.timer);
          if (message.error) { const error = new Error(message.error.message || "Runtime request failed."); error.type = message.error.type; entry.reject(error); }
          else entry.resolve(message.result);
        });
        current.addEventListener("error", () => fail(new Error("Unable to reach the runtime.")));
        current.addEventListener("close", (event) => {
          if (!isCurrent()) return;
          clearInterval(heartbeatTimer); socket = null; rejectPending();
          const error = new Error("Runtime connection closed.");
          if (event.code === WS_UNAUTHORIZED) error.code = "auth_required";
          fail(error);
        });
      }).catch(fail);
    });
    return connecting;
  }

  async function request(method, params = {}, timeoutMs = LONG_REQUESTS.has(method) ? 15 * 60_000 : 30_000) {
    await connect();
    const requestId = nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) entry.timer = setTimeout(() => { if (pending.delete(requestId)) reject(new Error(`Runtime request timed out: ${method}`)); }, timeoutMs);
      pending.set(requestId, entry);
      try { socket.send(JSON.stringify({ kind: "request", request_id: requestId, method, params })); }
      catch (error) { pending.delete(requestId); clearTimeout(entry.timer); reject(error); }
    });
  }

  function disconnect() {
    stopped = true; cancelConnect?.(); ++generation;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearInterval(heartbeatTimer); rejectPending();
    const current = socket; socket = null; connecting = null;
    current?.close();
  }

  function setUrl(nextUrl) {
    const target = new URL(String(nextUrl).trim());
    if (!["ws:", "wss:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("Invalid worker address.");
    if (target.href === url) return;
    disconnect(); url = target.href;
  }

  return { connect, request, disconnect, setUrl, setCredentialProvider: (provider) => { credential = provider; }, get url() { return url; }, get connected() { return socket?.readyState === WebSocket.OPEN; } };
}
