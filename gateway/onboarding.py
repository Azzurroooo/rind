"""Per-channel onboarding guides: setup steps, field forms, live probes.

This is the "特化设计" layer behind `gateway init` / `gateway doctor`: each
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
    """给 bot 发条消息即可被抓到：60 秒内轮询 getUpdates 收集发送者 ID。"""
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
        summary="最省事的国际渠道：@BotFather 三句话建好，个人账号即可，无需公网",
        setup_steps=(
            "1) Telegram 里搜索 @BotFather → 发送 /newbot → 按提示起名（username 以 bot 结尾）",
            "2) 复制它回复的 token（形如 123456:AAE...，泄露即等于交出 bot）",
            "3) 想知道自己的数字 ID：给 @userinfobot 发任意消息",
        ),
        fields=(FieldSpec("token", "Bot Token", secret=True),),
        probe=_probe_telegram,
        sdk_module="aiogram",
        discover_senders=_discover_telegram,
    ),
    "discord": ChannelGuide(
        id="discord",
        label="Discord",
        emoji="🎮",
        summary="个人账号即可；务必开启 MESSAGE CONTENT INTENT，零公网",
        setup_steps=(
            "1) discord.com/developers/applications → New Application → 左侧 Bot → Reset Token",
            "2) 同页打开 Privileged Gateway Intents → MESSAGE CONTENT INTENT（不开收不到消息内容）",
            "3) OAuth2 → URL Generator → 勾 bot + 发消息/读历史/附件/表情权限 → 用生成的 URL 把 bot 加进你的服务器",
        ),
        fields=(FieldSpec("token", "Bot Token", secret=True),),
        probe=_probe_discord,
        sdk_module="discord",
    ),
    "slack": ChannelGuide(
        id="slack",
        label="Slack",
        emoji="💼",
        summary="Socket Mode 零公网，适合企业内网",
        setup_steps=(
            "1) api.slack.com/apps → Create App → From scratch → 开启 Socket Mode（需要 App-Level Token，xapp- 开头）",
            "2) OAuth & Permissions → 安装到工作区 → 拿 Bot Token（xoxb- 开头）",
            "3) 订阅 message 事件并加 bot 用户",
        ),
        fields=(
            FieldSpec("bot_token", "Bot Token (xoxb-)", secret=True),
            FieldSpec("app_token", "App-Level Token (xapp-)", secret=True),
        ),
        probe=_probe_slack,
        sdk_module="slack_bolt",
    ),
    "qq": _passive(
        "qq",
        "QQ",
        "🐧",
        "无需注册任何机器人：NapCat 挂小号，主号当用户（国内零门槛首选）",
        (
            "1) 下载 NapCat（GitHub NapNeko/NapCatQQ Releases，Windows 用 NapCat.Shell）",
            "2) 启动后用小号扫码登录（小号 = bot 本体）",
            "3) NapCat WebUI → 网络配置 → 新建『反向 WebSocket 连接』→ URL 填 ws://127.0.0.1:8082/onebot/v11",
            "4) 用大号给小号发消息即可开始配对",
        ),
        (
            FieldSpec("ws_port", "反向 WS 端口", default="8082", required=False),
            FieldSpec("ws_path", "反向 WS 路径", default="/onebot/v11", required=False),
            FieldSpec("access_token", "共享密钥（可选）", secret=True, required=False),
        ),
    ),
    "feishu": ChannelGuide(
        id="feishu",
        label="飞书",
        emoji="🕊️",
        summary="个人版即可，长连接模式不需要公网 IP",
        setup_steps=(
            "1) open.feishu.cn → 开发者后台 → 创建企业自建应用（个人版账号即可）",
            "2) 应用能力 → 添加『机器人』",
            "3) 权限管理 → 勾：接收单聊/群聊消息、发送消息、读写图片文件、添加回复",
            "4) 事件订阅 → 连接方式选『使用长连接接收事件』→ 添加 im.message.receive_v1",
            "5) 版本管理与发布 → 创建版本并发布（个人版自己审批）",
        ),
        fields=(
            FieldSpec("app_id", "App ID"),
            FieldSpec("app_secret", "App Secret", secret=True),
        ),
        probe=_probe_feishu,
        sdk_module="lark_oapi",
    ),
    "dingtalk": ChannelGuide(
        id="dingtalk",
        label="钉钉",
        emoji="📌",
        summary="Stream 模式零公网；个人钉钉开发者即可创建应用机器人",
        setup_steps=(
            "1) open-dev.dingtalk.com → 创建应用 → 获取 client_id（AppKey）与 client_secret",
            "2) 添加『机器人』能力并发布",
            "3) 消息接收模式选 Stream 模式",
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
        label="企业微信",
        emoji="🏢",
        summary="自建应用回调方案；需要公网可达的回调地址（内网穿透亦可）",
        setup_steps=(
            "1) work.weixin.qq.com 管理后台 → 应用管理 → 创建自建应用 → 拿 AgentId 与 Secret",
            "2) 我的企业 → 企业信息 → 拿 CorpID",
            "3) 接收消息 → 设置回调（URL 指向本机的 callback_port，随机 Token 与 EncodingAESKey 填到这里）",
            "4) 公网暴露建议 cloudflared tunnel 或企业防火墙放行",
        ),
        fields=(
            FieldSpec("corp_id", "CorpID"),
            FieldSpec("agent_id", "AgentId"),
            FieldSpec("secret", "应用 Secret", secret=True),
            FieldSpec("encoding_aes_key", "EncodingAESKey", secret=True),
            FieldSpec("token", "回调 Token", secret=True),
            FieldSpec("callback_host", "回调监听地址", default="0.0.0.0", required=False),
            FieldSpec("callback_port", "回调端口", default="8081", required=False),
        ),
        probe=_probe_wecom,
        sdk_module="aiohttp",
    ),
    "whatsapp": ChannelGuide(
        id="whatsapp",
        label="WhatsApp",
        emoji="🌐",
        summary="Meta Cloud API；需要 Meta 开发者账号与公网 Webhook",
        setup_steps=(
            "1) developers.facebook.com → 创建 App → 添加 WhatsApp 产品",
            "2) WhatsApp → API Setup → 拿临时 access_token 与 phone_number_id（正式用永久 token）",
            "3) 配置 Webhook（指向本机 webhook_port，verify_token 自定义）",
        ),
        fields=(
            FieldSpec("phone_number_id", "Phone Number ID"),
            FieldSpec("access_token", "Access Token", secret=True),
            FieldSpec("verify_token", "Webhook Verify Token", secret=True),
            FieldSpec("webhook_port", "Webhook 端口", default="8080", required=False),
        ),
        probe=_probe_whatsapp,
        sdk_module="aiohttp",
    ),
    "email": ChannelGuide(
        id="email",
        label="Email",
        emoji="📧",
        summary="零注册：现有邮箱 + 授权码即可（QQ/163 邮箱在设置里开启 IMAP/SMTP）",
        setup_steps=(
            "1) 邮箱设置 → 账户 → 开启 IMAP/SMTP 服务",
            "2) 生成『授权码』（QQ/163 用授权码而非登录密码）",
            "3) 收发件服务器地址与端口在邮箱帮助页可查（QQ：imap.qq.com:993 / smtp.qq.com:465）",
        ),
        fields=(
            FieldSpec("imap_host", "IMAP 服务器", default="imap.qq.com"),
            FieldSpec("imap_port", "IMAP 端口", default="993", required=False),
            FieldSpec("smtp_host", "SMTP 服务器", default="smtp.qq.com"),
            FieldSpec("smtp_port", "SMTP 端口", default="465", required=False),
            FieldSpec("username", "邮箱账号"),
            FieldSpec("password", "授权码", secret=True),
            FieldSpec("mailbox", "收件箱", default="INBOX", required=False),
            FieldSpec("poll_interval", "轮询间隔(秒)", default="30", required=False),
        ),
        probe=_probe_email,
    ),
}


def guide_for(channel_id: str) -> ChannelGuide | None:
    return GUIDES.get(channel_id)


def all_guides() -> list[ChannelGuide]:
    return [GUIDES[key] for key in sorted(GUIDES)]


__all__ = ["GUIDES", "ChannelGuide", "FieldSpec", "ProbeResult", "all_guides", "guide_for"]
