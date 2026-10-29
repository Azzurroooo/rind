import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { Credential } from "../domain/models.js";

export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const RESOURCE = "https://api.openai.com/v1";
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
export const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
export const REFRESH_BEFORE_SECONDS = 5 * 60;
export const TOKEN_TIMEOUT_SECONDS = 15;
export const ACCOUNT_NAME = "ChatGPT";
export const SIGNED_IN_PAGE = `Signed in to ${ACCOUNT_NAME}. You can close this page and return to Rind.`;
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface AuthInteraction {
  prompt(kind: string, message: string, options?: readonly string[] | null): Promise<string>;
  notify(event: Record<string, unknown>): void;
}

export function expiring(credential: Credential): boolean {
  return (
    credential.expires_at !== undefined &&
    credential.expires_at !== null &&
    credential.expires_at - Date.now() / 1000 <= REFRESH_BEFORE_SECONDS
  );
}

export async function fresh(credential: Credential): Promise<Credential> {
  if (!expiring(credential)) {
    return credential;
  }
  return await fetchToken(
    {
      grant_type: "refresh_token",
      client_id: credential.client_id || "",
      refresh_token: credential.refresh || "",
      resource: RESOURCE,
    },
    credential.client_id || "",
  );
}

export async function login(interaction: AuthInteraction): Promise<Credential> {
  const verifier = randomToken();
  const state = randomToken();
  let resolveCallback: ((value: [string, string]) => void) | null = null;
  const callbackPromise = new Promise<[string, string]>(resolve => {
    resolveCallback = resolve;
  });

  const server = http.createServer((req, res) => {
    const rawUrl = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${req.url || "/"}`;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>Rind</title><p>Bad request.</p>");
      return;
    }
    if (parsed.pathname !== CALLBACK_PATH) {
      const body = "<!doctype html><meta charset=utf-8><title>Rind</title><p>Not found.</p>";
      res.writeHead(404, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      });
      res.end(body);
      return;
    }
    let status = 200;
    let page = SIGNED_IN_PAGE;
    try {
      const result = parseAuthorization(parsed, state);
      resolveCallback?.(result);
    } catch (err) {
      status = 400;
      page = (err as Error).message;
    }
    const body = `<!doctype html><meta charset=utf-8><title>Rind</title><p>${page}</p>`;
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    });
    res.end(body);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve());
    });
  } catch {
    throw new Error(
      `Port ${CALLBACK_PORT} is in use, probably by another unfinished sign-in or the Codex CLI. Finish or cancel it, then try again.`,
    );
  }

  const url = buildAuthorizeUrl(verifier, state);
  interaction.notify({
    type: "auth_url",
    message: `Sign in with ChatGPT in your browser. If it did not open, visit: ${url}`,
  });

  const pastedPromise = interaction.prompt(
    "text",
    "Waiting for your browser… or paste the redirect URL here",
  );

  let code = "";
  let clientId = "";
  try {
    const winner = await Promise.race([
      callbackPromise.then(val => ({ kind: "callback" as const, value: val })),
      pastedPromise.then(val => ({ kind: "pasted" as const, value: val })),
    ]);
    if (winner.kind === "callback") {
      [code, clientId] = winner.value;
    } else {
      const answer = winner.value.trim();
      if (!answer) {
        throw new Error("Login canceled.");
      }
      let parsed: URL;
      try {
        parsed = new URL(answer);
      } catch {
        throw new Error(`Paste the full redirect URL; it starts with ${REDIRECT_URI}`);
      }
      [code, clientId] = parseAuthorization(parsed, state);
    }
  } finally {
    server.close();
  }

  return await fetchToken(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    },
    clientId,
  );
}

function buildAuthorizeUrl(verifier: string, state: string): string {
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const params = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: "Rind",
    ext_agent_host_id: `urn:uuid:${hostId()}`,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: randomToken(),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function hostId(): string {
  const digest = createHash("sha1").update(`rind-host:${process.arch}:${process.platform}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function parseAuthorization(url: URL, state: string): [string, string] {
  if (`${url.protocol}//${url.host}${url.pathname}` !== REDIRECT_URI) {
    throw new Error(`Paste the full redirect URL; it starts with ${REDIRECT_URI}`);
  }
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`ChatGPT sign-in failed: ${url.searchParams.get("error_description") || error}`);
  }
  if (url.searchParams.get("state") !== state) {
    throw new Error("That redirect belongs to another sign-in. Run /login again.");
  }
  const code = url.searchParams.get("code") || "";
  const clientId = url.searchParams.get("client_id") || "";
  if (!code || !clientId) {
    throw new Error("The redirect URL has no authorization code.");
  }
  return [code, clientId];
}

async function fetchToken(form: Record<string, string>, clientId: string): Promise<Credential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (response.status !== 200) {
    let reason = "";
    try {
      const error = (await response.json()) as Record<string, unknown>;
      reason = String(error.error_description || error.error || "");
    } catch {
      reason = "";
    }
    throw new Error(
      `ChatGPT sign-in failed (${response.status}${reason ? `: ${reason}` : ""}). Run /login again.`,
    );
  }
  const token = (await response.json()) as Record<string, unknown>;
  const scopes = String(token.scope || "").split(/\s+/);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(
      "This ChatGPT account cannot use its subscription with Rind (no API access was granted).",
    );
  }
  return {
    type: "oauth",
    access: String(token.access_token || ""),
    refresh: String(token.refresh_token || ""),
    expires_at: Math.trunc(Date.now() / 1000 + Number(token.expires_in || 3600)),
    client_id: clientId,
  };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
