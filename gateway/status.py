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
from .probes import worker_alive
from .security import APPROVE_COMMAND


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - status never crashes on a bad file
        return None


def channel_label(channel_id: str) -> str:
    guide = GUIDES.get(channel_id)
    return f"{guide.emoji} {guide.label}" if guide else channel_id


def pending_lines(entries: Any) -> list[str]:
    """One line per pending pairing request: code, identity, minutes to expiry."""
    import time

    now = time.time()
    lines: list[str] = []
    for code, entry in (entries or {}).items():
        if not isinstance(entry, dict):
            continue
        minutes = max(0, int((float(entry.get("expires", 0.0)) - now) // 60))
        lines.append(f"  {code}  {entry.get('channel', '?')} · {entry.get('sender_id', '?')}（{minutes} 分钟后过期）")
    return lines


def startup_panel(worker: str, channels: list[tuple[str, bool]], pairing_enabled: bool) -> str:
    """The one screen a running gateway prints once ready ("我起来了吗？"不用猜).

    Failed channels stay visible with the single repair path (`gateway doctor`)
    instead of hiding in log lines.
    """
    worker_line = "已连接（stdio 自起子进程）" if worker == "stdio" else f"已连接（{worker}）"
    if channels:
        channel_line = "   ".join(
            f"{channel_label(channel_id)} {'✔' if started else '✘'}" for channel_id, started in channels
        )
    else:
        channel_line = "（未配置任何渠道——运行 python main.py gateway init 添加）"
    pairing_line = (
        "已开启——陌生账号发消息会收到 6 位配对码"
        if pairing_enabled
        else "已关闭——仅 allow_from / group_allow 名单内的账号可用"
    )
    lines = [
        "━━━ Rind 网关已就绪 ━━━",
        f"  worker   {worker_line}",
        f"  渠道     {channel_line}",
        f"  配对     {pairing_line}",
        f"  批准     {APPROVE_COMMAND.format(code='<配对码>')}（不带码 = 查看待批列表）",
    ]
    failed = [channel_id for channel_id, started in channels if not started]
    if failed:
        lines.append(f"  修复     python main.py gateway doctor（{'、'.join(channel_label(c) for c in failed)} 未就绪）")
    lines.append("按 Ctrl+C 停止网关。")
    return "\n".join(lines)


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
    for line in pending_lines(pending):
        print(line)
    if pending:
        print(f"    批准：{APPROVE_COMMAND.format(code='<配对码>')}（不带码 = 查看待批列表）")

    for channel_id, channel in config.channels.items():
        allow = len(channel.allow_from)
        groups = len(channel.group_allow)
        print(f"  渠道 {channel_label(channel_id)}：allow_from {allow} 条 · group_allow {groups} 条")

    if config.worker == "stdio":
        print("  worker：stdio 模式——worker 由网关进程自起，随网关同生共死")
    else:
        alive, detail = asyncio.run(worker_alive(config.worker, config.worker_token))
        mark = "✔" if alive else "✘"
        print(f"  worker：{mark} {detail}（{config.worker}）")
        if not alive:
            return 1
    return 0


__all__ = ["run_status"]
