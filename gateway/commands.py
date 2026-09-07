"""Channel text commands: one tiered registry feeding /help and dispatch.

The pump's decision row 4 delegates here for any text starting with ``/``.
Commands are control traffic: they pass security like ordinary messages, run
before the question/prompt rows, keep LRU dedup, and never land in the worker
as prompts.  While the worker is offline the pump queues them with a one-line
notice (flush replays the same command row).  Handlers return the reply text
(or ``None`` to stay silent) and receive a narrow :class:`HubLinks` view of
pump state — no session logic lives outside the pump.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from . import InboundMessage, SendTarget
from .errors import user_error_line

logger = logging.getLogger(__name__)

COMMAND_PREFIX = "/"
# Local method constants (mirrors agent.runtime.server.protocol; keeps this
# module importable without the agent package, like router.py).
SESSION_CANCEL_METHOD = "session/cancel"
SESSION_COMPACT_METHOD = "rind/session/compact"

STOPPED_REPLY = "已停止"
COMPACT_ACK = "已请求压缩上下文"
UNKNOWN_REPLY = "未知命令，回复 /help 查看。"
OFFLINE_NOTICE = "worker 离线，命令暂存"
SESSION_CREATE_FAILED_REPLY = "暂时无法创建会话，稍后再试"
NO_SESSION_REPLY = "当前没有会话，发送消息后即可压缩"


@dataclass(frozen=True, slots=True)
class CommandContext:
    """Where the command came from; the pump builds it per message."""

    channel_id: str
    target: SendTarget
    message: InboundMessage
    key: str


@dataclass(frozen=True, slots=True)
class HubLinks:
    """Pump-owned state the command layer may touch (narrow interface)."""

    active_session: Callable[[str], str | None]  # key → running turn's session id
    finish_turn: Callable[[str], Awaitable[None]]  # local turn cleanup (typing, slots)
    queue_depth: Callable[[], int]  # offline buffer depth
    bind_target: Callable[[str, tuple[str, SendTarget]], None]  # session → reply position


@dataclass(frozen=True, slots=True)
class CommandSpec:
    name: str  # without the slash
    tier: str  # "essential" | "standard"
    description: str
    handler: Callable[["CommandHub", CommandContext], Awaitable[str | None]]


def is_command(text: str) -> bool:
    return text.startswith(COMMAND_PREFIX)


def command_name(text: str) -> str:
    return text[len(COMMAND_PREFIX):].split(None, 1)[0].lower() if text[len(COMMAND_PREFIX):].strip() else ""


class CommandHub:
    """Registry-backed dispatcher; handlers are bound methods listed in COMMANDS.

    ``worker_getter`` is read on every use so a swapped worker client (tests,
    reconnect scaffolding) is always the live one.
    """

    def __init__(self, *, worker_getter: Callable[[], Any], router: Any, links: HubLinks,
                 workspace_root: str = "", request_timeout: float = 120.0,
                 model: str = "默认（worker 内置）") -> None:
        self._worker_getter = worker_getter
        self._router = router
        self._links = links
        self._workspace_root = workspace_root
        self._request_timeout = request_timeout
        self._model = model

    @property
    def _worker(self) -> Any:
        return self._worker_getter()

    async def dispatch(self, text: str, ctx: CommandContext) -> str | None:
        """One command line → reply text; unknown names get the /help hint."""
        spec = COMMANDS.get(command_name(text))
        if spec is None:
            return UNKNOWN_REPLY
        try:
            return await spec.handler(self, ctx)
        except Exception as exc:  # noqa: BLE001 - every command failure answers the user
            logger.warning("gateway: /%s failed: %s", spec.name, exc)
            return user_error_line(exc)

    # --- handlers -----------------------------------------------------------------

    async def cmd_stop(self, ctx: CommandContext) -> str | None:
        session = self._links.active_session(ctx.key)
        if session is None:  # nothing running: stay silent (legacy row-4 behavior)
            return None
        try:
            await self._worker.request(SESSION_CANCEL_METHOD, {"session_id": session}, self._request_timeout)
        except Exception as exc:  # noqa: BLE001 - stop still means stop locally
            logger.warning("gateway: /stop cancel failed: %s", exc)
        await self._links.finish_turn(ctx.key)
        return STOPPED_REPLY

    async def cmd_new(self, ctx: CommandContext) -> str | None:
        session = self._links.active_session(ctx.key)
        if session is not None:  # a fresh conversation starts by stopping the old turn
            try:
                await self._worker.request(SESSION_CANCEL_METHOD, {"session_id": session}, self._request_timeout)
            except Exception as exc:  # noqa: BLE001
                logger.warning("gateway: /new cancel failed: %s", exc)
            await self._links.finish_turn(ctx.key)
        try:
            record = await self._router.create_session(ctx.key, self._worker, self._workspace_root)
            await self._worker.subscribe(record.session_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("gateway: /new session create failed for %s: %s", ctx.key, exc)
            return SESSION_CREATE_FAILED_REPLY
        self._links.bind_target(record.session_id, (ctx.channel_id, ctx.target))
        return f"已开启新会话（session {record.session_id[:8]}）"

    async def cmd_status(self, ctx: CommandContext) -> str | None:
        active = self._links.active_session(ctx.key)
        queued = self._links.queue_depth()
        connected = bool(getattr(self._worker, "connected", True))
        parts = [f"模型：{self._model}",
                 "任务：" + ("运行中" if active else "空闲") + (f"（排队 {queued}）" if queued > 0 else ""),
                 f"会话：{len(self._router.all_sessions())} 个",
                 "worker：" + ("已连接" if connected else "离线")]
        return "｜".join(parts)

    async def cmd_compact(self, ctx: CommandContext) -> str | None:
        session = self._links.active_session(ctx.key)
        if session is None:
            record = self._router.lookup(ctx.key)
            session = record.session_id if record is not None else None
        if session is None:
            return NO_SESSION_REPLY
        await self._worker.request(SESSION_COMPACT_METHOD, {"session_id": session}, self._request_timeout)
        return COMPACT_ACK

    async def cmd_help(self, ctx: CommandContext) -> str | None:
        essential = [spec for spec in COMMANDS.values() if spec.tier == "essential"]
        standard = [spec for spec in COMMANDS.values() if spec.tier != "essential"]
        lines = ["常用：", *[_line(spec) for spec in essential], "全部：", *[_line(spec) for spec in standard]]
        return "\n".join(lines)


def _line(spec: CommandSpec) -> str:
    return f"/{spec.name} {spec.description}"


# Single source for /help rendering and dispatch. Handlers are unbound methods;
# dict order defines the help listing.
COMMANDS: dict[str, CommandSpec] = {
    "stop": CommandSpec("stop", "essential", "停止当前任务", CommandHub.cmd_stop),
    "new": CommandSpec("new", "essential", "开启新会话", CommandHub.cmd_new),
    "status": CommandSpec("status", "essential", "查看状态", CommandHub.cmd_status),
    "compact": CommandSpec("compact", "essential", "压缩上下文", CommandHub.cmd_compact),
    "help": CommandSpec("help", "standard", "显示本帮助", CommandHub.cmd_help),
}


__all__ = [
    "COMMANDS",
    "COMPACT_ACK",
    "CommandContext",
    "CommandHub",
    "CommandSpec",
    "HubLinks",
    "OFFLINE_NOTICE",
    "UNKNOWN_REPLY",
    "command_name",
    "is_command",
]
