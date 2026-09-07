"""TurnPump: the gateway's only business logic (remote-plan/gateway.md §5).

Inbound rows (ordered): message_ref LRU dedup → security verdict → text
commands (/stop /new /status /compact /help …, control traffic) →
pending-question digits → follow_up while a turn is active → session/prompt.
While the worker is offline, inbound buffers in memory (100 cap, §1; commands
queue with a one-line notice) and flushes in order on reconnect.  Durable
events advance the session cursor and drive the reaction controller.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Any

from agent.runtime.server.protocol import RuntimeMethod

from . import Channel, InboundMessage, OutboundPayload, SendTarget
from .chunk import first_line_title
from .commands import SESSION_CREATE_FAILED_REPLY, STOPPED_REPLY, CommandContext, CommandHub, HubLinks, is_command
from .errors import user_error_line
from .outbound import Outbound
from .reactions import ReactionController
from .router import SessionRouter, session_key
from .security import SecurityGate
from .worker_client import REQUEST_TIMEOUT_SECONDS, WorkerClient, WorkerError

logger = logging.getLogger(__name__)

MESSAGE_REF_LRU_SIZE, INBOUND_QUEUE_LIMIT = 512, 100  # §1: offline buffer cap
QUESTION_TTL_SECONDS, QUESTION_SCAN_SECONDS = 300.0, 30.0
TURN_STUCK_SECONDS = 30 * 60.0  # a turn active longer than this is force-reset
TERMINAL_EVENT_TYPES = ("turn_completed", "turn_failed", "turn_cancelled")
QUESTION_EXPIRED_REPLY, WORKER_UNRESPONSIVE_REPLY = "问题已超时", "worker 暂时无响应，已重试排队"


@dataclass(slots=True)
class _ActiveTurn:
    # One running turn: typing lifecycle, first-piece task title, liveness.
    session_id: str
    channel_id: str
    target: SendTarget
    started_at: float
    turn_id: str = ""
    title: str = ""
    confirmed: bool = False


@dataclass(slots=True)
class _PendingQuestion:
    # A user_question awaiting a numbered-text answer until its deadline.
    key: str
    session_id: str
    channel_id: str
    target: SendTarget
    tool_call_id: str
    options: tuple[str, ...]
    deadline: float


class TurnPump:
    """Inbound decision table + event→outbound mapping; channel-agnostic."""

    def __init__(self, *, worker: WorkerClient, router: SessionRouter, security: SecurityGate,
                 workspace_root: str, clock: Any = time.monotonic, question_ttl: float = QUESTION_TTL_SECONDS,
                 scan_interval: float = QUESTION_SCAN_SECONDS,
                 request_timeout: float = REQUEST_TIMEOUT_SECONDS,
                 reactions: ReactionController | None = None) -> None:
        self._worker, self._router, self._security = worker, router, security
        self._workspace_root, self._clock = workspace_root, clock
        self._question_ttl, self._scan_interval = question_ttl, scan_interval
        self._request_timeout = request_timeout
        self._channels: dict[str, Channel] = {}
        self._out = Outbound(self._channels)
        self._seen_refs: OrderedDict[str, None] = OrderedDict()
        self._pending_inbound: deque[InboundMessage] = deque()
        self._turns: dict[str, _ActiveTurn] = {}
        self._questions: dict[str, _PendingQuestion] = {}
        self._targets: dict[str, tuple[str, SendTarget]] = {}
        self._reactions = reactions or ReactionController(react=self._out.react_emoji)
        links = HubLinks(active_session=self.active_session, finish_turn=self._finish_turn,
                         queue_depth=lambda: len(self._pending_inbound), bind_target=self._targets.__setitem__)
        self._commands = CommandHub(worker_getter=lambda: self._worker, router=router, links=links,
                                    workspace_root=workspace_root, request_timeout=request_timeout)
        worker.on_event(self.handle_event)  # register before worker.start()

    def register_channel(self, channel: Channel) -> None:
        self._channels[channel.id] = channel

    def active_session(self, key: str) -> str | None:
        """Session id of the turn running on ``key`` (command-layer view)."""
        turn = self._turns.get(key)
        return turn.session_id if turn is not None else None

    async def run(self) -> None:
        """Scan pending questions and stuck turns until cancelled."""
        while True:
            await asyncio.sleep(self._scan_interval)
            if self._pending_inbound and bool(getattr(self._worker, "connected", True)):
                await self._flush_queued()
            await self._expire_questions()
            await self._reset_stuck_turns()

    # --- inbound decision table (ordered rows) ----------------------------------

    async def inbound(self, message: InboundMessage) -> None:
        if not bool(getattr(self._worker, "connected", True)):  # §1: buffer while offline
            self._pending_inbound.append(message)
            while len(self._pending_inbound) > INBOUND_QUEUE_LIMIT:
                dropped = self._pending_inbound.popleft()
                logger.warning("gateway: worker offline; dropping queued message %s", dropped.message_ref)
            if is_command(message.text.strip()):  # commands queue too, but say so
                await self._out.send(message.channel, self._target_of(message),
                                     OutboundPayload(text="worker 离线，命令暂存"))
            return
        if self._pending_inbound:  # preserve ordering: older messages first
            await self._flush_queued()
        await self._process(message)

    async def _flush_queued(self) -> None:
        while self._pending_inbound:
            await self._process(self._pending_inbound.popleft())

    async def _process(self, message: InboundMessage) -> None:
        if self._is_duplicate(message):  # row 1
            return
        verdict = self._security.admit(message)  # rows 2-3: pairing / silent deny
        if not verdict.allow:
            if verdict.notice:
                await self._out.send(message.channel, self._target_of(message), OutboundPayload(text=verdict.notice))
            return
        key = session_key(message)
        text = message.text.strip()
        if text.startswith("/"):  # row 4: control commands (also /stop); never prompts
            ctx = CommandContext(channel_id=message.channel, target=self._target_of(message), message=message, key=key)
            reply = await self._commands.dispatch(text, ctx)
            if reply:
                await self._out.send(message.channel, ctx.target, OutboundPayload(text=reply))
            return
        question = self._questions.get(key)  # row 5: numbered answer (or button text)
        numbered = {str(index) for index in range(1, len(question.options) + 1)} if question else set()
        if question is not None and self._clock() < question.deadline and text in numbered:
            await self._answer_question(question, question.options[int(text) - 1])
            return
        record = await self._ensure_session(message, key)  # rows 6-7
        if record is None:
            return
        self._targets[record.session_id] = self._target_of(message)
        turn = self._turns.get(key)
        method = RuntimeMethod.RIND_SESSION_FOLLOW_UP if turn is not None else RuntimeMethod.SESSION_PROMPT
        await self._dispatch_input(key, message, record, text, method, new_turn=turn is None)

    def _is_duplicate(self, message: InboundMessage) -> bool:
        ref = message.message_ref
        if not ref:
            return False
        if ref in self._seen_refs:
            return True
        self._seen_refs[ref] = None
        while len(self._seen_refs) > MESSAGE_REF_LRU_SIZE:
            self._seen_refs.popitem(last=False)
        return False

    def _target_of(self, message: InboundMessage) -> SendTarget:
        return SendTarget(chat_id=message.chat_id, thread_id=message.thread_id)

    async def _answer_question(self, question: _PendingQuestion, answer: str) -> None:
        self._questions.pop(question.key, None)
        params = {"session_id": question.session_id, "tool_call_id": question.tool_call_id, "answer": answer}
        try:
            await self._worker.request(RuntimeMethod.RIND_USER_QUESTION_RESPOND, params, self._request_timeout)
        except WorkerError as exc:
            logger.warning("gateway: user-question respond failed: %s", exc)

    async def _ensure_session(self, message: InboundMessage, key: str):
        try:
            record = await self._router.ensure_session(key, self._worker, self._workspace_root)
            await self._worker.subscribe(record.session_id)
            return record
        except Exception as exc:  # noqa: BLE001 - every failure path answers the user
            logger.warning("gateway: session resolve failed for %s: %s", key, exc)
            await self._out.send(message.channel, self._target_of(message),
                                 OutboundPayload(text=SESSION_CREATE_FAILED_REPLY))
            return None

    async def _dispatch_input(self, key: str, message: InboundMessage, record, text: str,
                              method: str, *, new_turn: bool) -> None:
        if new_turn:
            self._turns[key] = _ActiveTurn(session_id=record.session_id, channel_id=message.channel,
                                           target=self._target_of(message), started_at=self._clock(),
                                           title=first_line_title(text))
            await self._reactions.queued((message.channel, self._target_of(message)))
        try:
            await self._worker.request(method, {"session_id": record.session_id, "input": text}, self._request_timeout)
        except WorkerError as exc:
            logger.warning("gateway: %s failed for %s: %s", method, key, exc)
            if new_turn and (turn := self._turns.get(key)) is not None and not turn.confirmed:
                self._turns.pop(key, None)  # unconfirmed prompt: no phantom active turn
                await self._reactions.cancel((message.channel, self._target_of(message)))
            await self._out.send(message.channel, self._target_of(message),
                                 OutboundPayload(text=WORKER_UNRESPONSIVE_REPLY))

    # --- worker events → outbound mapping -----------------------------------------

    async def handle_event(self, envelope: dict, replayed: bool = False) -> None:
        session_id = str(envelope.get("session_id") or "")
        event = envelope.get("event") or {}
        etype = str(event.get("type") or "")
        key = self._router.key_for_session(session_id)
        if key is None:
            logger.debug("gateway: event for unrouted session %s (%s)", session_id, etype)
            return
        if envelope.get("durability") == "durable":  # cursor: durable ordinal, not transport sequence
            self._router.update_cursor(key, self._router.cursor_for(key) + 1)
        position = self._position(key)
        await self._reactions.on_event(position, event, replayed=replayed)
        if etype in ("tool_requested", "tool_result"):
            logger.debug("gateway: %s on session %s (never sent to channels)", etype, session_id)
            return
        if etype == "turn_started":
            await self._on_turn_started(key, session_id, str(envelope.get("turn_id") or ""))
        elif etype == "user_question_requested":
            await self._on_question(key, session_id, event)
        elif etype == "assistant_message_completed":
            await self._on_assistant(key, event)
        elif etype in TERMINAL_EVENT_TYPES:
            await self._finish_turn(key)  # typing stop lands before any terminal reply
            if etype == "turn_failed":
                detail = f"{user_error_line(event)}（session {session_id[:8]}）"
                await self._out.reply(position, detail)
            elif etype == "turn_cancelled":
                await self._out.reply(position, STOPPED_REPLY)  # ✅ receipt rides the reaction hook

    async def _on_turn_started(self, key: str, session_id: str, turn_id: str) -> None:
        turn = self._turns.get(key)
        if turn is None:
            position = self._targets.get(session_id)
            if position is None:
                return
            turn = self._turns[key] = _ActiveTurn(session_id=session_id, channel_id=position[0],
                                                  target=position[1], started_at=self._clock())
        turn.confirmed = True
        turn.turn_id = turn_id
        self._out.start_typing(key, turn.channel_id, turn.target, asyncio.get_running_loop())

    async def _on_question(self, key: str, session_id: str, event: dict) -> None:
        position = self._position(key, session_id)
        if position is None:
            return
        options = tuple(str(option.get("label") if isinstance(option, dict) else option)
                        for option in event.get("options") or [])
        await self._out.send_question(position, str(event.get("question") or "请选择："), options)
        pending = _PendingQuestion(key, session_id, position[0], position[1], str(event.get("tool_call_id") or ""),
                                   options, self._clock() + self._question_ttl)
        self._questions[key] = pending

    async def _on_assistant(self, key: str, event: dict) -> None:
        position = self._position(key)
        content = str(event.get("content") or "")
        if position is None or not content.strip():
            return
        turn = self._turns.get(key)
        await self._out.send_assistant(position, content, turn.title if turn is not None else "")

    async def _finish_turn(self, key: str) -> None:
        self._turns.pop(key, None)
        await self._out.stop_typing(key)

    def _position(self, key: str, session_id: str | None = None) -> tuple[str, SendTarget] | None:
        turn = self._turns.get(key)
        if turn is not None:
            return turn.channel_id, turn.target
        record = self._router.lookup(key) if session_id is None else None
        session_id = session_id or (record.session_id if record else None)
        return self._targets.get(session_id) if session_id else None

    async def _expire_questions(self) -> None:
        now = self._clock()
        for question in [q for q in self._questions.values() if now >= q.deadline]:
            self._questions.pop(question.key, None)
            timeout = next((o for o in question.options if "超时" in o or "timeout" in o.lower()), None)
            if timeout is not None:  # respond the timeout choice, stay quiet
                await self._answer_question(question, timeout)
            else:
                await self._out.reply((question.channel_id, question.target), QUESTION_EXPIRED_REPLY)

    async def _reset_stuck_turns(self) -> None:
        for key, turn in list(self._turns.items()):
            if self._clock() - turn.started_at <= TURN_STUCK_SECONDS:
                continue
            logger.warning("gateway: turn on %s active for over 30 minutes; forcing idle", key)
            await self._reactions.cancel((turn.channel_id, turn.target))
            await self._finish_turn(key)


__all__ = ["TurnPump"]
