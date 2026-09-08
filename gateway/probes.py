"""Live credential probes for each channel (plain urllib / stdlib).

Split from onboarding.py to keep both files within budget. Probe functions
take the wizard's answers and return ProbeResult — they report, never raise.
Tests inject fake HTTP by monkeypatching ``_get_json`` / ``_post_json``.
"""

from __future__ import annotations

import asyncio
import imaplib
import json
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

PROBE_TIMEOUT = 8.0


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    detail: str


def _opener(proxy: str = "") -> urllib.request.OpenerDirector:
    """Egress policy: use the configured proxy, otherwise connect DIRECT.

    System proxies are deliberately bypassed — the gateway's HTTP clients do
    not honor them either, so a probe that quietly used the OS proxy would
    report a false pass while the real channel times out.
    """
    handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {})
    return urllib.request.build_opener(handler)


def _get_json(url: str, headers: dict[str, str] | None = None, proxy: str = "") -> tuple[int, Any]:
    request = urllib.request.Request(url, headers=headers or {})
    with _opener(proxy).open(request, timeout=PROBE_TIMEOUT) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None, proxy: str = "") -> tuple[int, Any]:
    body = json.dumps(payload).encode("utf-8")
    merged = {"Content-Type": "application/json", **(headers or {})}
    request = urllib.request.Request(url, data=body, headers=merged)
    with _opener(proxy).open(request, timeout=PROBE_TIMEOUT) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _ok(detail: str) -> ProbeResult:
    return ProbeResult(True, detail)


def _fail(detail: str) -> ProbeResult:
    return ProbeResult(False, detail)


# --- per-channel probes (answers: field name -> value) -------------------------


def _probe_telegram(a: dict[str, str]) -> ProbeResult:
    proxy = a.get("proxy", "")
    try:
        status, body = _get_json(f"https://api.telegram.org/bot{a['token']}/getMe", proxy=proxy)
        if status == 200 and body.get("ok"):
            return _ok(f"bot @{body['result'].get('username', '?')}")
        return _fail(f"Telegram 返回 {status}：{str(body)[:120]}")
    except Exception as exc:  # noqa: BLE001 - probe reports, never raises
        detail = str(exc)
        if "timed out" in detail or "timeout" in detail.lower():
            hint = "" if proxy else "请在『代理地址』填入你的代理（如 http://127.0.0.1:7890）后重试。"
            return _fail(f"连接超时——api.telegram.org 无法直连。{hint}")
        return _fail(f"连接失败：{detail}")


def _probe_discord(a: dict[str, str]) -> ProbeResult:
    try:
        status, body = _get_json(
            "https://discord.com/api/v10/users/@me", headers={"Authorization": f"Bot {a['token']}"}
        )
        if status == 200:
            return _ok(f"bot {body.get('username', '?')}")
        return _fail(f"Discord 返回 {status}（401 = token 无效；注意开启 MESSAGE CONTENT INTENT）")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"连接失败：{exc}")


def _probe_slack(a: dict[str, str]) -> ProbeResult:
    try:
        status, body = _post_json(
            "https://slack.com/api/auth.test", {}, headers={"Authorization": f"Bearer {a['bot_token']}"}
        )
        if body.get("ok"):
            return _ok(f"team {body.get('team', '?')} / bot {body.get('user', '?')}")
        return _fail(f"Slack auth.test 失败：{body.get('error', status)}")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"连接失败：{exc}")


def _probe_feishu(a: dict[str, str]) -> ProbeResult:
    try:
        _status, body = _post_json(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            {"app_id": a["app_id"], "app_secret": a["app_secret"]},
        )
        if body.get("code") == 0:
            return _ok("tenant_access_token 获取成功（应用凭证有效）")
        return _fail(f"飞书返回 code={body.get('code')}：{body.get('msg', '')}")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"连接失败：{exc}")


def _probe_dingtalk(a: dict[str, str]) -> ProbeResult:
    try:
        query = urllib.parse.urlencode({"appkey": a["client_id"], "appsecret": a["client_secret"]})
        _status, body = _get_json(f"https://oapi.dingtalk.com/gettoken?{query}")
        if body.get("errcode") == 0:
            return _ok("access_token 获取成功（应用凭证有效）")
        return _fail(f"钉钉返回 errcode={body.get('errcode')}：{body.get('errmsg', '')}")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"连接失败：{exc}")


def _probe_wecom(a: dict[str, str]) -> ProbeResult:
    try:
        query = urllib.parse.urlencode({"corpid": a["corp_id"], "corpsecret": a["secret"]})
        _status, body = _get_json(f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?{query}")
        if body.get("errcode") == 0:
            return _ok("access_token 获取成功（应用凭证有效）")
        return _fail(f"企业微信返回 errcode={body.get('errcode')}：{body.get('errmsg', '')}")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"连接失败：{exc}")


def _probe_whatsapp(a: dict[str, str]) -> ProbeResult:
    try:
        url = f"https://graph.facebook.com/v20.0/{a['phone_number_id']}?access_token={a['access_token']}"
        status, body = _get_json(url)
        if status == 200 and body.get("id"):
            return _ok(f"号码 {body.get('display_phone_number', body.get('id'))} 验证通过")
        return _fail(f"Graph API 返回 {status}：{str(body)[:120]}")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"连接失败：{exc}")


def _probe_email(a: dict[str, str]) -> ProbeResult:
    port = int(a.get("imap_port") or 993)
    try:
        client = imaplib.IMAP4_SSL(a["imap_host"], port)
        try:
            client.login(a["username"], a["password"])
            return _ok(f"IMAP 登录成功：{a['username']}")
        finally:
            client.logout()
    except Exception as exc:  # noqa: BLE001
        return _fail(f"IMAP 登录失败：{exc}（检查授权码/IMAP 服务是否开启）")


def _probe_qq(a: dict[str, str]) -> ProbeResult:
    return _ok("被动通道：启动网关后，NapCat 反向连接即在线")


async def worker_alive(worker: str, token: str | None, timeout: float = 5.0) -> tuple[bool, str]:
    """Real WS handshake probe for ws:// workers ("worker 开着吗" 不靠猜).

    ``stdio`` workers are owned by the gateway process itself, so callers
    branch on that before probing. websockets imports lazily to keep this
    module importable without the gateway dependency set.
    """
    try:
        import websockets
    except Exception as exc:  # noqa: BLE001
        return False, f"websockets 不可用：{exc}"
    url = worker
    if token:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}token={token}"

    async def probe() -> tuple[bool, str]:
        async with websockets.connect(url, open_timeout=timeout) as ws:
            await ws.send(json.dumps({"kind": "request", "request_id": "probe-1", "method": "initialize", "params": {}}))
            deadline = asyncio.get_running_loop().time() + timeout
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    return False, "initialize 超时"
                envelope = json.loads(await asyncio.wait_for(ws.recv(), timeout=remaining))
                if envelope.get("kind") == "response":
                    return True, "worker 在线，initialize 通过"

    try:
        return await asyncio.wait_for(probe(), timeout=timeout + 2)
    except Exception as exc:  # noqa: BLE001
        return False, f"无法连接：{exc}"


