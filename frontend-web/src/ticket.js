// Ticket exchange + browser credential storage for the rind web surface.
//
// Storage rules (web-ui.md §5):
//   - sessionStorage ONLY. localStorage must never hold any credential.
//   - The page keeps a short-lived ticket (`rind_ticket`) for the
//     refresh-without-relogin path, plus the server token so a fresh ticket
//     can be minted for every WS (re)connect — tickets are one-time.
//   - The token also lives in a module-scope variable for the tab lifetime so
//     reconnects mint fresh tickets even if sessionStorage is unavailable.

const TOKEN_KEY = "rind_token";
export const TICKET_KEY = "rind_ticket";

let memoryToken = "";

function sessionStorageSafe() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredToken() {
  if (memoryToken) return memoryToken;
  const storage = sessionStorageSafe();
  return storage ? String(storage.getItem(TOKEN_KEY) || "").trim() : "";
}

export function storeToken(token) {
  const clean = String(token || "").trim();
  memoryToken = clean;
  const storage = sessionStorageSafe();
  if (storage) {
    if (clean) storage.setItem(TOKEN_KEY, clean);
    else storage.removeItem(TOKEN_KEY);
  }
}

export function readStoredTicket() {
  const storage = sessionStorageSafe();
  return storage ? String(storage.getItem(TICKET_KEY) || "").trim() : "";
}

export function storeTicket(ticket) {
  const clean = String(ticket || "").trim();
  const storage = sessionStorageSafe();
  if (storage) {
    if (clean) storage.setItem(TICKET_KEY, clean);
    else storage.removeItem(TICKET_KEY);
  }
}

export function dropCredentials() {
  memoryToken = "";
  const storage = sessionStorageSafe();
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
  storage.removeItem(TICKET_KEY);
}

export function hasStoredCredential() {
  return Boolean(readStoredToken() || readStoredTicket());
}

// Exchanges a server token for a one-time WS ticket (worker-core.md §4).
// GET by necessity: websockets 16's HTTP parser rejects non-GET before
// process_request, so the worker endpoint is GET /ticket + Bearer header.
// Rejects with `error.status` set (401 → bad token, 0 → network failure).
export async function fetchTicket(serverToken, { endpoint = "/ticket", fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) {
    const error = new Error("fetch is unavailable in this environment");
    error.status = 0;
    throw error;
  }
  let response;
  try {
    response = await doFetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${String(serverToken || "")}` },
    });
  } catch {
    const error = new Error("network unreachable");
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`ticket request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const ticket = String(data?.ticket || "").trim();
  if (!ticket) {
    const error = new Error("ticket response did not include a ticket");
    error.status = response.status;
    throw error;
  }
  return ticket;
}

export function loginErrorMessage(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403) return "令牌无效或已被拒绝，请检查后重试。";
  if (status === 0) return "无法连接服务器，请确认 worker 地址后重试。";
  return error?.message ? `连接失败：${error.message}` : "连接失败，请稍后重试。";
}

export function unauthorizedMessage() {
  return "登录已失效，请重新输入令牌。";
}
