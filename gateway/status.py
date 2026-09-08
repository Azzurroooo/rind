"""`gateway status`: 一屏看清网关现在怎么样 —— 不需要打开任何文件。

Static facts come from config/state/pairing files; the worker liveness ping is
a real WS handshake (short timeout) so "worker 开着吗" has a definite answer.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from .config import ConfigError, load_config
from .onboarding import GUIDES


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - status never crashes on a bad file
        return None


async def _worker_alive(worker: str, token: str | None, timeout: float = 5.0) -> tuple[bool, str]:
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
            await ws.send(json.dumps({"kind": "request", "request_id": "status-1", "method": "initialize", "params": {}}))
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


def run_status(args) -> int:
    workspace = Path(args.workspace).expanduser().resolve()
    config_path = Path(args.config) if args.config else workspace / ".rind" / "gateway.yaml"
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        print(f"网关未配置：{exc}", file=sys.stderr)
        print("运行 `python main.py gateway init` 逐步创建。", file=sys.stderr)
        return 2

    print("Rind 网关状态")
    print(f"  配置：{config_path}")
    runtime_dir = workspace / ".rind"

    state = _load_json(runtime_dir / "state.json") or {}
    sessions = state.get("sessions") or {}
    print(f"  会话映射：{len(sessions)} 个")
    for key, record in list(sessions.items())[:8]:
        cursor = record.get("cursor", 0) if isinstance(record, dict) else "?"
        print(f"    · {key} → {record.get('session_id', '?') if isinstance(record, dict) else '?'}（游标 {cursor}）")
    if len(sessions) > 8:
        print(f"    … 其余 {len(sessions) - 8} 个")

    pairing = _load_json(runtime_dir / "pairing.json") or {}
    pending = pairing.get("pending") or {}
    approved = pairing.get("approved") or []
    print(f"  配对：{len(pending)} 个待批准，{len(approved)} 个已批准")
    for code, entry in list(pending.items())[:5]:
        if isinstance(entry, dict):
            print(f"    · {code}（{entry.get('channel', '?')} · {entry.get('sender_id', '?')}）")
    if pending:
        print("    批准：python main.py gateway approve <配对码>")

    for channel_id, channel in config.channels.items():
        guide = GUIDES.get(channel_id)
        label = guide.label if guide else channel_id
        allow = len(channel.allow_from)
        groups = len(channel.group_allow)
        print(f"  渠道 {label}：allow_from {allow} 条 · group_allow {groups} 条")

    alive, detail = asyncio.run(_worker_alive(config.worker, config.worker_token))
    mark = "✔" if alive else "✘"
    print(f"  worker：{mark} {detail}（{config.worker}）")
    return 0 if alive else 1


__all__ = ["run_status"]
