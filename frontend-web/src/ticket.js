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
let memoryScope = "";
const SCOPE_KEY = "rind_credential_server";

// Pairing codes travel only in the URL fragment, never in HTTP requests.
// Clear the fragment before login so it is absent from copied page addresses.
export function consumePairingCode() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const code = fragment.get("connect");
  if (!code) return "";
  fragment.delete("connect");
  const rest = fragment.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`);
  return /^[A-Za-z0-9_-]{32}$/.test(code) ? code : "";
}

function matchesScope(scope) {
  return !scope || (memoryScope || sessionStorageSafe()?.getItem(SCOPE_KEY)) === scope;
}

function sessionStorageSafe() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredToken(scope = "") {
  if (!matchesScope(scope)) return "";
  if (memoryToken) return memoryToken;
  const storage = sessionStorageSafe();
  return storage ? String(storage.getItem(TOKEN_KEY) || "").trim() : "";
}

export function storeToken(token, scope = "") {
  const clean = String(token || "").trim();
  memoryToken = clean;
  memoryScope = scope;
  const storage = sessionStorageSafe();
  if (storage) {
    if (scope) storage.setItem(SCOPE_KEY, scope);
    else storage.removeItem(SCOPE_KEY);
    if (clean) storage.setItem(TOKEN_KEY, clean);
    else storage.removeItem(TOKEN_KEY);
  }
}

export function readStoredTicket(scope = "") {
  if (!matchesScope(scope)) return "";
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
  memoryScope = "";
  const storage = sessionStorageSafe();
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
  storage.removeItem(TICKET_KEY);
  storage.removeItem(SCOPE_KEY);
}

export function hasStoredCredential(scope = "") {
  return Boolean(readStoredToken(scope) || readStoredTicket(scope));
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
  if (status === 401 || status === 403) return "Access code invalid or expired. Copy the current code from Rind Desktop and try again.";
  if (status === 0) return "Cannot reach Rind. Keep Rind Desktop open and check that both devices are connected to the same network.";
  return error?.message ? `Connection failed: ${error.message}` : "Connection failed. Try again later.";
}

export function unauthorizedMessage() {
  return "Access has expired. Enter the current access code from Rind Desktop.";
}
