"""Per-channel onboarding guides: setup steps, field forms, live probes.

This is the "channel-specific" layer behind `gateway init` / `gateway doctor`: each
channel describes, in user language, where its credentials come from, which
fields the wizard must ask for, and how to verify them live (plain urllib
against the platform's HTTP API — no channel SDK required, failures degrade to
a manual hint). Channel adapter files stay §8-pure; this module owns guidance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .probes import ProbeResult, _get_json, _probe_discord, _probe_dingtalk, _probe_email, _probe_feishu, _probe_qq, _probe_slack, _probe_telegram, _probe_wecom, _probe_whatsapp

PROBE_TIMEOUT = 8.0


@dataclass(frozen=True)
class FieldSpec:
    name: str
    label: str
    help: str = ""
    secret: bool = False
    required: bool = True
    default: str = ""


@dataclass(frozen=True)
class ChannelGuide:
    id: str
    label: str
    emoji: str
    summary: str
    setup_steps: tuple[str, ...]
    fields: tuple[FieldSpec, ...] = field(default_factory=tuple)
    probe: Callable[[dict[str, str]], ProbeResult] | None = None
    discover_senders: Callable[[dict[str, str], float], list[str]] | None = None
    """Optional sender-id discovery (telegram getUpdates)."""
    sdk_module: str = ""  # importable name used by `gateway doctor` SDK checks
    runtime_deps: tuple[str, ...] = ()  # extra pip deps (e.g. aiohttp_socks for proxy setups), auto-installed with sdk_module
    scopes: tuple[str, ...] = ()  # unique permission/event codes users can paste directly into the platform's search box


def _get_json(url: str, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> tuple[int, Any]:
    body = json.dumps(payload).encode("utf-8")
    merged = {"Content-Type": "application/json", **(headers or {})}
    request = urllib.request.Request(url, data=body, headers=merged)
    with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _ok(detail: str) -> ProbeResult:
    return ProbeResult(True, detail)


def _fail(detail: str) -> ProbeResult:
    return ProbeResult(False, detail)


def _passive(id_: str, label: str, emoji: str, summary: str, steps: tuple[str, ...], fields: tuple[FieldSpec, ...]) -> ChannelGuide:
    return ChannelGuide(id=id_, label=label, emoji=emoji, summary=summary, setup_steps=steps, fields=fields, probe=_probe_qq)


def _discover_telegram(a: dict[str, str], wait: float) -> list[str]:
    """Message the bot once to be seen: polls getUpdates for up to 60s collecting sender IDs."""
    import time

    seen: dict[str, str] = {}
    deadline = time.monotonic() + wait
    offset = 0
    while time.monotonic() < deadline:
        try:
            _status, body = _get_json(
                f"https://api.telegram.org/bot{a['token']}/getUpdates?timeout=3&offset={offset}"
            )
            for update in body.get("result") or []:
                offset = max(offset, int(update.get("update_id", 0)) + 1)
                message = update.get("message") or {}
                sender = message.get("from") or {}
                if sender.get("id"):
                    label = f"{sender['id']}"
                    if sender.get("username"):
                        label += f" (@{sender['username']})"
                    seen[label] = str(sender["id"])
        except Exception:  # noqa: BLE001 - discovery is best-effort
            pass
        if seen:
            return sorted(seen)
        time.sleep(1)
    return []


GUIDES: dict[str, ChannelGuide] = {
    "telegram": ChannelGuide(
        id="telegram",
        label="Telegram",
        emoji="✈️",
        summary="Easiest international channel: three messages to @BotFather, personal account, no public network needed",
        setup_steps=(
            "1) In Telegram, find @BotFather → send /newbot → follow the prompts (username must end in bot)",
            "2) Copy the token it replies with (looks like 123456:AAE...; a leak hands over the bot)",
            "3) To learn your numeric ID: send any message to @userinfobot",
            "4) Restricted networks: the proxy must go in the proxy field below (system proxies do not apply to the gateway)",
            "5) For group chats keep the default privacy mode (the bot only sees @mentions/replies, matching the gateway's gating)",
        ),
        fields=(
            FieldSpec("token", "Bot Token", secret=True),
            FieldSpec("proxy", "Proxy URL (optional, e.g. http://127.0.0.1:7890)", required=False),
        ),
        probe=_probe_telegram,
        sdk_module="aiogram",
        runtime_deps=("aiohttp_socks",),
        discover_senders=_discover_telegram,
    ),
    "discord": ChannelGuide(
        id="discord",
        label="Discord",
        emoji="🎮",
        summary="Personal account works; be sure to enable MESSAGE CONTENT INTENT, zero public exposure",
        setup_steps=(
            "1) discord.com/developers/applications → New Application → Bot (left sidebar) → Reset Token",
            "2) On the same page open Privileged Gateway Intents → MESSAGE CONTENT INTENT (without it, message content is unreadable)",
            "3) OAuth2 → URL Generator → tick bot + send/read history/attachments/reactions permissions → use the generated URL to add the bot to your server",
        ),
        fields=(FieldSpec("token", "Bot Token", secret=True),),
        probe=_probe_discord,
        sdk_module="discord",
        scopes=(
            "MESSAGE CONTENT INTENT (Privileged Gateway Intents toggle on the Bot page)",
            "Server permissions: View Channels / Send Messages / Attach Files / Add Reactions / Read Message History",
        ),
    ),
    "slack": ChannelGuide(
        id="slack",
        label="Slack",
        emoji="💼",
        summary="Socket Mode: zero public exposure, fits enterprise intranets",
        setup_steps=(
            "1) api.slack.com/apps → Create App → From scratch → enable Socket Mode (needs an App-Level Token, xapp- prefix)",
            "2) OAuth & Permissions → Install to Workspace → copy the Bot Token (xoxb- prefix)",
            "3) Subscribe to message events and add the bot user",
        ),
        fields=(
            FieldSpec("bot_token", "Bot Token (xoxb-)", secret=True),
            FieldSpec("app_token", "App-Level Token (xapp-)", secret=True),
        ),
        probe=_probe_slack,
        sdk_module="slack_bolt",
        scopes=(
            "chat:write",
            "channels:history",
            "groups:history",
            "im:history",
            "files:read",
            "files:write",
            "reactions:write",
            "connections:write (app_token/xapp- only)",
        ),
    ),
    "qq": _passive(
        "qq",
        "QQ",
        "🐧",
        "No bot registration needed: run NapCat on a secondary account, main account as the user (the zero-friction option in mainland China)",
        (
            "1) Download NapCat (GitHub NapNeko/NapCatQQ Releases; NapCat.Shell on Windows)",
            "2) Launch it and log in by QR code with the secondary account (that account is the bot)",
            "3) NapCat WebUI → Network → create a \"Reverse WebSocket Connection\" → set the URL to ws://127.0.0.1:8082/onebot/v11",
            "4) Message the secondary account from your main account to start pairing",
        ),
        (
            FieldSpec("ws_port", "Reverse WS port", default="8082", required=False),
            FieldSpec("ws_path", "Reverse WS path", default="/onebot/v11", required=False),
            FieldSpec("access_token", "Shared secret (optional)", secret=True, required=False),
        ),
    ),
    "feishu": ChannelGuide(
        id="feishu",
        label="Feishu",
        emoji="🕊️",
        summary="Personal edition works; long-connection mode needs no public IP",
        setup_steps=(
            "1) open.feishu.cn → Developer Console → create a \"Custom App\" (any name/description; a personal-edition account works)",
            "2) \"Add App Capabilities\" on the left → enable \"Bot\" (skip this and the bot never shows up in chats)",
            "3) \"Credentials & Basic Info\" page → copy the App ID / App Secret into the fields below",
            "4) \"Permissions & Scopes\" → enable: read DMs users send to the bot, receive @bot group messages, send messages as the bot, get/upload image or file resources",
            "5) \"Events & Callbacks\" → choose \"Use long connection to receive events\" → add the event \"Receive message im.message.receive_v1\" (skip this and no messages arrive either)",
            "6) \"Version Management & Release\" → create a version and publish (custom apps take effect after self-approval)",
        ),
        fields=(
            FieldSpec("app_id", "App ID"),
            FieldSpec("app_secret", "App Secret", secret=True),
        ),
        probe=_probe_feishu,
        sdk_module="lark_oapi",
        scopes=(
            "im:message.p2p.msg:readonly (read user-to-bot DMs)",
            "im:message.group_at_msg:readonly (receive @bot group messages)",
            "im:message:send_as_bot (send messages as the bot)",
            "im:resource (get/upload image and file resources)",
        ),
    ),
    "dingtalk": ChannelGuide(
        id="dingtalk",
        label="DingTalk",
        emoji="📌",
        summary="Stream mode: zero public exposure; any personal DingTalk developer can create an app bot",
        setup_steps=(
            "1) open-dev.dingtalk.com → Create App → get the client_id (AppKey) and client_secret",
            "2) Add the \"Bot\" capability and publish",
            "3) Set the message receive mode to Stream Mode",
        ),
        fields=(
            FieldSpec("client_id", "Client ID (AppKey)"),
            FieldSpec("client_secret", "Client Secret", secret=True),
        ),
        probe=_probe_dingtalk,
        sdk_module="dingtalk_stream",
    ),
    "wecom": ChannelGuide(
        id="wecom",
        label="WeCom",
        emoji="🏢",
        summary="Self-built app with callbacks; needs a publicly reachable callback URL (a tunnel works)",
        setup_steps=(
            "1) work.weixin.qq.com admin console → App Management → create a self-built app → get the AgentId and Secret",
            "2) My Company → Company Info → get the CorpID",
            "3) Receive Messages → Set Callback (URL points at this machine's callback_port; fill the random Token and EncodingAESKey here)",
            "4) For public exposure, a cloudflared tunnel or a corporate firewall opening is recommended",
        ),
        fields=(
            FieldSpec("corp_id", "CorpID"),
            FieldSpec("agent_id", "AgentId"),
            FieldSpec("secret", "App Secret", secret=True),
            FieldSpec("encoding_aes_key", "EncodingAESKey", secret=True),
            FieldSpec("token", "Callback Token", secret=True),
            FieldSpec("callback_host", "Callback listen address", default="0.0.0.0", required=False),
            FieldSpec("callback_port", "Callback port", default="8081", required=False),
        ),
        probe=_probe_wecom,
        sdk_module="aiohttp",
    ),
    "whatsapp": ChannelGuide(
        id="whatsapp",
        label="WhatsApp",
        emoji="🌐",
        summary="Meta Cloud API; needs a Meta developer account and a public webhook",
        setup_steps=(
            "1) developers.facebook.com → Create App → add the WhatsApp product",
            "2) WhatsApp → API Setup → get the temporary access_token and phone_number_id (switch to a permanent token for production)",
            "3) Configure the webhook (point it at this machine's webhook_port; pick your own verify_token)",
        ),
        fields=(
            FieldSpec("phone_number_id", "Phone Number ID"),
            FieldSpec("access_token", "Access Token", secret=True),
            FieldSpec("verify_token", "Webhook Verify Token", secret=True),
            FieldSpec("webhook_port", "Webhook port", default="8080", required=False),
        ),
        probe=_probe_whatsapp,
        sdk_module="aiohttp",
    ),
    "email": ChannelGuide(
        id="email",
        label="Email",
        emoji="📧",
        summary="Zero signup: an existing mailbox plus an authorization code (enable IMAP/SMTP in QQ/163 mailbox settings)",
        setup_steps=(
            "1) Mailbox settings → Account → enable IMAP/SMTP service",
            "2) Generate an \"authorization code\" (QQ/163 mailboxes use it instead of the login password)",
            "3) Server addresses and ports are on the mailbox help pages (QQ: imap.qq.com:993 / smtp.qq.com:465)",
        ),
        fields=(
            FieldSpec("imap_host", "IMAP server", default="imap.qq.com"),
            FieldSpec("imap_port", "IMAP port", default="993", required=False),
            FieldSpec("smtp_host", "SMTP server", default="smtp.qq.com"),
            FieldSpec("smtp_port", "SMTP port", default="465", required=False),
            FieldSpec("username", "Mailbox account"),
            FieldSpec("password", "Authorization code", secret=True),
            FieldSpec("mailbox", "Mailbox", default="INBOX", required=False),
            FieldSpec("poll_interval", "Poll interval (seconds)", default="30", required=False),
        ),
        probe=_probe_email,
    ),
}


def guide_for(channel_id: str) -> ChannelGuide | None:
    return GUIDES.get(channel_id)


def all_guides() -> list[ChannelGuide]:
    return [GUIDES[key] for key in sorted(GUIDES)]


__all__ = ["GUIDES", "ChannelGuide", "FieldSpec", "ProbeResult", "all_guides", "guide_for"]
