import { defaultFetch } from "./channels/http-ws-utils.js";

export const PROBE_TIMEOUT_MS = 8000;

export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeHooks {
  readonly getJson?: (
    url: string,
    headers?: Record<string, string>,
    proxy?: string,
  ) => Promise<readonly [number, Record<string, unknown>]>;
  readonly postJson?: (
    url: string,
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
    proxy?: string,
  ) => Promise<readonly [number, Record<string, unknown>]>;
  readonly imapLogin?: (params: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  }) => Promise<void>;
}

let activeHooks: ProbeHooks | null = null;

export function setProbeHooks(hooks: ProbeHooks | null): void {
  activeHooks = hooks;
}

export async function probeGetJson(
  url: string,
  headers?: Record<string, string>,
  proxy = "",
): Promise<readonly [number, Record<string, unknown>]> {
  if (activeHooks?.getJson) {
    return await activeHooks.getJson(url, headers, proxy);
  }
  const fetchImpl = defaultFetch(proxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: headers ?? {},
      signal: controller.signal,
    });
    const text = await resp.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    return [
      resp.status,
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    ];
  } finally {
    clearTimeout(timer);
  }
}

export async function probePostJson(
  url: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
  proxy = "",
): Promise<readonly [number, Record<string, unknown>]> {
  if (activeHooks?.postJson) {
    return await activeHooks.postJson(url, payload, headers, proxy);
  }
  const fetchImpl = defaultFetch(proxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await resp.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    return [
      resp.status,
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    ];
  } finally {
    clearTimeout(timer);
  }
}

function ok(detail: string): ProbeResult {
  return { ok: true, detail };
}

function fail(detail: string): ProbeResult {
  return { ok: false, detail };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function probeTelegram(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  const proxy = String(answers.proxy ?? "");
  const token = String(answers.token ?? "");
  try {
    const [status, body] = await probeGetJson(
      `https://api.telegram.org/bot${token}/getMe`,
      undefined,
      proxy,
    );
    if (status === 200 && body.ok) {
      const result =
        body.result && typeof body.result === "object"
          ? (body.result as Record<string, unknown>)
          : {};
      return ok(`bot @${String(result.username ?? "?")}`);
    }
    return fail(`Telegram returned ${status}: ${JSON.stringify(body).slice(0, 120)}`);
  } catch (err) {
    const detail = errorMessage(err);
    const lower = detail.toLowerCase();
    if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("abort")) {
      const hint = proxy
        ? ""
        : "Enter your proxy in the proxy field (e.g. http://127.0.0.1:7890) and retry.";
      return fail(
        `Connection timed out — api.telegram.org is not directly reachable. ${hint}`.trim(),
      );
    }
    return fail(`Connection failed: ${detail}`);
  }
}

export async function probeDiscord(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  try {
    const [status, body] = await probeGetJson("https://discord.com/api/v10/users/@me", {
      Authorization: `Bot ${String(answers.token ?? "")}`,
    });
    if (status === 200) {
      return ok(`bot ${String(body.username ?? "?")}`);
    }
    return fail(
      `Discord returned ${status} (401 = invalid token; make sure MESSAGE CONTENT INTENT is on)`,
    );
  } catch (err) {
    return fail(`Connection failed: ${errorMessage(err)}`);
  }
}

export async function probeSlack(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  try {
    const [status, body] = await probePostJson(
      "https://slack.com/api/auth.test",
      {},
      { Authorization: `Bearer ${String(answers.bot_token ?? "")}` },
    );
    if (body.ok) {
      return ok(`team ${String(body.team ?? "?")} / bot ${String(body.user ?? "?")}`);
    }
    return fail(`Slack auth.test failed: ${String(body.error ?? status)}`);
  } catch (err) {
    return fail(`Connection failed: ${errorMessage(err)}`);
  }
}

export async function probeFeishu(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  try {
    const [_status, body] = await probePostJson(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        app_id: String(answers.app_id ?? ""),
        app_secret: String(answers.app_secret ?? ""),
      },
    );
    if (body.code === 0) {
      return ok("tenant_access_token acquired (app credentials valid)");
    }
    return fail(`Feishu returned code=${String(body.code)}: ${String(body.msg ?? "")}`);
  } catch (err) {
    return fail(`Connection failed: ${errorMessage(err)}`);
  }
}

export async function probeDingtalk(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  try {
    const query = new URLSearchParams({
      appkey: String(answers.client_id ?? ""),
      appsecret: String(answers.client_secret ?? ""),
    });
    const [_status, body] = await probeGetJson(
      `https://oapi.dingtalk.com/gettoken?${query.toString()}`,
    );
    if (body.errcode === 0) {
      return ok("access_token acquired (app credentials valid)");
    }
    return fail(
      `DingTalk returned errcode=${String(body.errcode)}: ${String(body.errmsg ?? "")}`,
    );
  } catch (err) {
    return fail(`Connection failed: ${errorMessage(err)}`);
  }
}

export async function probeWecom(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  try {
    const query = new URLSearchParams({
      corpid: String(answers.corp_id ?? ""),
      corpsecret: String(answers.secret ?? ""),
    });
    const [_status, body] = await probeGetJson(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?${query.toString()}`,
    );
    if (body.errcode === 0) {
      return ok("access_token acquired (app credentials valid)");
    }
    return fail(
      `WeCom returned errcode=${String(body.errcode)}: ${String(body.errmsg ?? "")}`,
    );
  } catch (err) {
    return fail(`Connection failed: ${errorMessage(err)}`);
  }
}

export async function probeWhatsapp(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  try {
    const phoneId = encodeURIComponent(String(answers.phone_number_id ?? ""));
    const query = new URLSearchParams({
      access_token: String(answers.access_token ?? ""),
    });
    const [status, body] = await probeGetJson(
      `https://graph.facebook.com/v20.0/${phoneId}?${query.toString()}`,
    );
    if (status === 200 && body.id) {
      return ok(
        `phone number ${String(body.display_phone_number ?? body.id)} verified`,
      );
    }
    return fail(`Graph API returned ${status}: ${JSON.stringify(body).slice(0, 120)}`);
  } catch (err) {
    return fail(`Connection failed: ${errorMessage(err)}`);
  }
}

export async function probeEmail(
  answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  const host = String(answers.imap_host ?? "");
  const port = Number(answers.imap_port || 993) || 993;
  const secure =
    answers.imap_ssl === undefined ? port === 993 : Boolean(answers.imap_ssl);
  const username = String(answers.username ?? "");
  const password = String(answers.password ?? "");
  try {
    if (activeHooks?.imapLogin) {
      await activeHooks.imapLogin({ host, port, secure, username, password });
      return ok(`IMAP login succeeded: ${username}`);
    }
    const { ImapFlow } = (await import("imapflow")) as unknown as {
      ImapFlow: new (opts: Record<string, unknown>) => {
        connect(): Promise<void>;
        logout(): Promise<void>;
      };
    };
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user: username, pass: password },
      logger: false,
    });
    await client.connect();
    try {
      return ok(`IMAP login succeeded: ${username}`);
    } finally {
      await client.logout().catch(() => {});
    }
  } catch (err) {
    return fail(
      `IMAP login failed: ${errorMessage(err)} (check the authorization code and that IMAP service is enabled)`,
    );
  }
}

export async function probeQq(
  _answers: Readonly<Record<string, unknown>>,
): Promise<ProbeResult> {
  return ok(
    "Passive channel: once the gateway starts, NapCat's reverse connection is online",
  );
}
