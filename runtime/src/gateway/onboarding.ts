import {
  type ProbeResult,
  probeDingtalk,
  probeDiscord,
  probeEmail,
  probeFeishu,
  probeGetJson,
  probeQq,
  probeSlack,
  probeTelegram,
  probeWecom,
  probeWhatsapp,
} from "./probes.js";

export type { ProbeResult };

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly help: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly default: string;
}

function field(
  name: string,
  label: string,
  options?: {
    help?: string;
    secret?: boolean;
    required?: boolean;
    default?: string;
  },
): FieldSpec {
  return Object.freeze({
    name,
    label,
    help: options?.help ?? "",
    secret: options?.secret ?? false,
    required: options?.required ?? true,
    default: options?.default ?? "",
  });
}

export interface ChannelGuide {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly summary: string;
  readonly setup_steps: readonly string[];
  readonly fields: readonly FieldSpec[];
  readonly probe: ((answers: Readonly<Record<string, unknown>>) => Promise<ProbeResult>) | null;
  readonly discover_senders:
    | ((
        answers: Readonly<Record<string, unknown>>,
        waitSeconds: number,
      ) => Promise<string[]>)
    | null;
  readonly scopes: readonly string[];
}

export async function discoverTelegram(
  answers: Readonly<Record<string, unknown>>,
  waitSeconds: number,
  options?: { sleepMs?: (ms: number) => Promise<void> },
): Promise<string[]> {
  const sleep =
    options?.sleepMs ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const seen = new Map<string, string>();
  const deadline = performance.now() + waitSeconds * 1000;
  const token = String(answers.token ?? "");
  const proxy = String(answers.proxy ?? "");
  let offset = 0;

  while (performance.now() < deadline) {
    try {
      const [_status, body] = await probeGetJson(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=3&offset=${offset}`,
        undefined,
        proxy,
      );
      const updates = Array.isArray(body.result) ? body.result : [];
      for (const update of updates) {
        if (!update || typeof update !== "object") continue;
        const u = update as Record<string, unknown>;
        offset = Math.max(offset, (Number(u.update_id ?? 0) || 0) + 1);
        const message =
          u.message && typeof u.message === "object"
            ? (u.message as Record<string, unknown>)
            : {};
        const sender =
          message.from && typeof message.from === "object"
            ? (message.from as Record<string, unknown>)
            : {};
        if (sender.id) {
          let label = String(sender.id);
          if (sender.username) {
            label += ` (@${String(sender.username)})`;
          }
          seen.set(label, String(sender.id));
        }
      }
    } catch {
      // discovery is best-effort
    }
    if (seen.size > 0) {
      return [...seen.keys()].sort();
    }
    await sleep(1000);
  }
  return [];
}

export const GUIDES: Readonly<Record<string, ChannelGuide>> = Object.freeze({
  telegram: Object.freeze({
    id: "telegram",
    label: "Telegram",
    emoji: "✈️",
    summary:
      "Easiest international channel: three messages to @BotFather, personal account, no public network needed",
    setup_steps: [
      "1) In Telegram, find @BotFather → send /newbot → follow the prompts (username must end in bot)",
      "2) Copy the token it replies with (looks like 123456:AAE...; a leak hands over the bot)",
      "3) To learn your numeric ID: send any message to @userinfobot",
      "4) Restricted networks: the proxy must go in the proxy field below (system proxies do not apply to the gateway)",
      "5) For group chats keep the default privacy mode (the bot only sees @mentions/replies, matching the gateway's gating)",
    ],
    fields: [
      field("token", "Bot Token", { secret: true }),
      field("proxy", "Proxy URL (optional, e.g. http://127.0.0.1:7890)", {
        required: false,
      }),
    ],
    probe: probeTelegram,
    discover_senders: (
      answers: Readonly<Record<string, unknown>>,
      wait: number,
    ) => discoverTelegram(answers, wait),
    scopes: [],
  }),
  discord: Object.freeze({
    id: "discord",
    label: "Discord",
    emoji: "🎮",
    summary:
      "Personal account works; be sure to enable MESSAGE CONTENT INTENT, zero public exposure",
    setup_steps: [
      "1) discord.com/developers/applications → New Application → Bot (left sidebar) → Reset Token",
      "2) On the same page open Privileged Gateway Intents → MESSAGE CONTENT INTENT (without it, message content is unreadable)",
      "3) OAuth2 → URL Generator → tick bot + send/read history/attachments/reactions permissions → use the generated URL to add the bot to your server",
    ],
    fields: [field("token", "Bot Token", { secret: true })],
    probe: probeDiscord,
    discover_senders: null,
    scopes: [
      "MESSAGE CONTENT INTENT (Privileged Gateway Intents toggle on the Bot page)",
      "Server permissions: View Channels / Send Messages / Attach Files / Add Reactions / Read Message History",
    ],
  }),
  slack: Object.freeze({
    id: "slack",
    label: "Slack",
    emoji: "💼",
    summary: "Socket Mode: zero public exposure, fits enterprise intranets",
    setup_steps: [
      "1) api.slack.com/apps → Create App → From scratch → enable Socket Mode (needs an App-Level Token, xapp- prefix)",
      "2) OAuth & Permissions → Install to Workspace → copy the Bot Token (xoxb- prefix)",
      "3) Subscribe to message events and add the bot user",
    ],
    fields: [
      field("bot_token", "Bot Token (xoxb-)", { secret: true }),
      field("app_token", "App-Level Token (xapp-)", { secret: true }),
    ],
    probe: probeSlack,
    discover_senders: null,
    scopes: [
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "files:read",
      "files:write",
      "reactions:write",
      "connections:write (app_token/xapp- only)",
    ],
  }),
  qq: Object.freeze({
    id: "qq",
    label: "QQ",
    emoji: "🐧",
    summary:
      "No bot registration needed: run NapCat on a secondary account, main account as the user (the zero-friction option in mainland China)",
    setup_steps: [
      "1) Download NapCat (GitHub NapNeko/NapCatQQ Releases; NapCat.Shell on Windows)",
      "2) Launch it and log in by QR code with the secondary account (that account is the bot)",
      '3) NapCat WebUI → Network → create a "Reverse WebSocket Connection" → set the URL to ws://127.0.0.1:8082/onebot/v11',
      "4) Message the secondary account from your main account to start pairing",
    ],
    fields: [
      field("ws_port", "Reverse WS port", { default: "8082", required: false }),
      field("ws_path", "Reverse WS path", { default: "/onebot/v11", required: false }),
      field("access_token", "Shared secret (optional)", {
        secret: true,
        required: false,
      }),
    ],
    probe: probeQq,
    discover_senders: null,
    scopes: [],
  }),
  feishu: Object.freeze({
    id: "feishu",
    label: "Feishu",
    emoji: "🕊️",
    summary: "Personal edition works; long-connection mode needs no public IP",
    setup_steps: [
      '1) open.feishu.cn → Developer Console → create a "Custom App" (any name/description; a personal-edition account works)',
      '2) "Add App Capabilities" on the left → enable "Bot" (skip this and the bot never shows up in chats)',
      '3) "Credentials & Basic Info" page → copy the App ID / App Secret into the fields below',
      '4) "Permissions & Scopes" → enable: read DMs users send to the bot, receive @bot group messages, send messages as the bot, get/upload image or file resources',
      '5) "Events & Callbacks" → choose "Use long connection to receive events" → add the event "Receive message im.message.receive_v1" (skip this and no messages arrive either)',
      '6) "Version Management & Release" → create a version and publish (custom apps take effect after self-approval)',
    ],
    fields: [
      field("app_id", "App ID"),
      field("app_secret", "App Secret", { secret: true }),
    ],
    probe: probeFeishu,
    discover_senders: null,
    scopes: [
      "im:message.p2p.msg:readonly (read user-to-bot DMs)",
      "im:message.group_at_msg:readonly (receive @bot group messages)",
      "im:message:send_as_bot (send messages as the bot)",
      "im:resource (get/upload image and file resources)",
    ],
  }),
  dingtalk: Object.freeze({
    id: "dingtalk",
    label: "DingTalk",
    emoji: "📌",
    summary:
      "Stream mode: zero public exposure; any personal DingTalk developer can create an app bot",
    setup_steps: [
      "1) open-dev.dingtalk.com → Create App → get the client_id (AppKey) and client_secret",
      '2) Add the "Bot" capability and publish',
      "3) Set the message receive mode to Stream Mode",
    ],
    fields: [
      field("client_id", "Client ID (AppKey)"),
      field("client_secret", "Client Secret", { secret: true }),
    ],
    probe: probeDingtalk,
    discover_senders: null,
    scopes: [],
  }),
  wecom: Object.freeze({
    id: "wecom",
    label: "WeCom",
    emoji: "🏢",
    summary:
      "Self-built app with callbacks; needs a publicly reachable callback URL (a tunnel works)",
    setup_steps: [
      "1) work.weixin.qq.com admin console → App Management → create a self-built app → get the AgentId and Secret",
      "2) My Company → Company Info → get the CorpID",
      "3) Receive Messages → Set Callback (URL points at this machine's callback_port; fill the random Token and EncodingAESKey here)",
      "4) For public exposure, a cloudflared tunnel or a corporate firewall opening is recommended",
    ],
    fields: [
      field("corp_id", "CorpID"),
      field("agent_id", "AgentId"),
      field("secret", "App Secret", { secret: true }),
      field("encoding_aes_key", "EncodingAESKey", { secret: true }),
      field("token", "Callback Token", { secret: true }),
      field("callback_host", "Callback listen address", {
        default: "0.0.0.0",
        required: false,
      }),
      field("callback_port", "Callback port", {
        default: "8081",
        required: false,
      }),
    ],
    probe: probeWecom,
    discover_senders: null,
    scopes: [],
  }),
  whatsapp: Object.freeze({
    id: "whatsapp",
    label: "WhatsApp",
    emoji: "🌐",
    summary:
      "Meta Cloud API; needs a Meta developer account and a public webhook",
    setup_steps: [
      "1) developers.facebook.com → Create App → add the WhatsApp product",
      "2) WhatsApp → API Setup → get the temporary access_token and phone_number_id (switch to a permanent token for production)",
      "3) Configure the webhook (point it at this machine's webhook_port; pick your own verify_token)",
    ],
    fields: [
      field("phone_number_id", "Phone Number ID"),
      field("access_token", "Access Token", { secret: true }),
      field("verify_token", "Webhook Verify Token", { secret: true }),
      field("webhook_port", "Webhook port", {
        default: "8080",
        required: false,
      }),
    ],
    probe: probeWhatsapp,
    discover_senders: null,
    scopes: [],
  }),
  email: Object.freeze({
    id: "email",
    label: "Email",
    emoji: "📧",
    summary:
      "Zero signup: an existing mailbox plus an authorization code (enable IMAP/SMTP in QQ/163 mailbox settings)",
    setup_steps: [
      "1) Mailbox settings → Account → enable IMAP/SMTP service",
      '2) Generate an "authorization code" (QQ/163 mailboxes use it instead of the login password)',
      "3) Server addresses and ports are on the mailbox help pages (QQ: imap.qq.com:993 / smtp.qq.com:465)",
    ],
    fields: [
      field("imap_host", "IMAP server", { default: "imap.qq.com" }),
      field("imap_port", "IMAP port", { default: "993", required: false }),
      field("smtp_host", "SMTP server", { default: "smtp.qq.com" }),
      field("smtp_port", "SMTP port", { default: "465", required: false }),
      field("username", "Mailbox account"),
      field("password", "Authorization code", { secret: true }),
      field("mailbox", "Mailbox", { default: "INBOX", required: false }),
      field("poll_interval", "Poll interval (seconds)", {
        default: "30",
        required: false,
      }),
    ],
    probe: probeEmail,
    discover_senders: null,
    scopes: [],
  }),
});

export function guideFor(channelId: string): ChannelGuide | undefined {
  return GUIDES[channelId];
}

export function allGuides(): ChannelGuide[] {
  return Object.keys(GUIDES)
    .sort()
    .map(key => GUIDES[key]!);
}
