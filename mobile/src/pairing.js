// All pairing sources pass through this parser before any network or storage access.
export function parsePairing(input, code = "") {
  let value = String(input || "").trim();
  if (!value || value.length > 4096) throw new Error("Enter your computer’s address or paste its sign-in link.");
  if (value.startsWith("rind://")) {
    const link = new URL(value);
    if (link.hostname !== "connect" || link.username || link.password || link.port || !["", "/"].includes(link.pathname) || link.searchParams.getAll("address").length !== 1 || [...link.searchParams.keys()].some((key) => key !== "address")) throw new Error("This is not a Rind connection link.");
    value = `${link.searchParams.get("address") || ""}${link.hash}`;
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `${isLocalHost(value.split(/[/:]/)[0]) ? "http" : "https"}://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid HTTP or HTTPS address."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search) throw new Error("Use the server address without a path, query or username.");
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) throw new Error("Use HTTPS outside a trusted local network.");
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].some((key) => key !== "connect") || fragment.getAll("connect").length > 1) throw new Error("This sign-in link is not valid.");
  const token = String(fragment.get("connect") || code).trim();
  if (token && (!/^[\x21-\x7e]+$/.test(token) || token.length > 2048)) throw new Error("The access code is not valid.");
  return { origin: url.origin, endpoint: `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws`, token };
}

export function isLocalHost(host) {
  const name = String(host).toLowerCase();
  if (name === "localhost" || name.endsWith(".local") || name === "[::1]") return true;
  if (/^\[(?:f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/i.test(name)) return true;
  const octets = name.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = octets.map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export function memoryCredentials(token, endpoint) {
  let current = token;
  return {
    readStoredToken: (scope) => scope === endpoint ? current : "",
    readStoredTicket: () => "",
    hasStoredCredential: (scope) => scope === endpoint && Boolean(current),
    storeToken: (value, scope) => { if (scope === endpoint) current = String(value).trim(); },
    dropCredentials: () => { current = ""; },
  };
}
