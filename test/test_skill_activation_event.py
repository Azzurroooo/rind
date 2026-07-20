import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.async_turn_runner import AsyncTurnRunner
from agent.domain import ParsedToolCall, Skill, SkillMatch
from agent.domain.events import AssistantDeltaEvent, ContextBuiltEvent, SkillActivatedEvent


def _skill(name: str = "demo") -> Skill:
    return Skill(
        name=name,
        description="Demo skill for tests.",
        body="# Demo\nFollow demo instructions.",
        path=f"/tmp/{name}/SKILL.md",
        triggers=["demo trigger"],
        source="project",
    )


class FakeSession:
    def __init__(self, user_content: str):
        self._messages = [{"role": "user", "content": user_content}]
        self.persisted_messages = []

    def now_iso(self) -> str:
        return "2026-05-19T00:00:00Z"

    async def get_messages_slice(self, *args, **kwargs):
        return [dict(message) for message in self._messages]

    async def persist_message(self, *args, **kwargs):
        self.persisted_messages.append((args, kwargs))


class FakeContextManager:
    def __init__(self, selected_matches: list[SkillMatch]):
        self.selected_matches = selected_matches
        self.selected_messages: list[str] = []
        self.build_active_matches: list[list[SkillMatch]] = []

    def select_active_skills_for_turn(self, user_message: str) -> list[SkillMatch]:
        self.selected_messages.append(user_message)
        return list(self.selected_matches)

    async def build_messages_async(self, *args, **kwargs):
        active_matches = list(kwargs.get("active_skill_matches") or [])
        self.build_active_matches.append(active_matches)
        return MagicMock(
            messages=[
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hello"},
            ],
            decisions={
                "active_skills": [
                    {
                        "name": match.skill.name,
                        "reason": match.reason,
                        "score": match.score,
                        "source": match.skill.source,
                        "path": match.skill.path,
                    }
                    for match in active_matches
                ]
            },
        )


@pytest.mark.asyncio
async def test_skill_activation_event_precedes_assistant_delta() -> None:
    mock_client = AsyncMock()

    async def mock_stream(*args, **kwargs):
        yield MagicMock()

    mock_client.stream = mock_stream

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        await on_content_async("Hello")
        return "Hello", []

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume
    skill = _skill()
    context_manager = FakeContextManager([SkillMatch(skill=skill, reason="explicit_dollar_name", score=100)])
    session = FakeSession("please use $demo")

    runner = AsyncTurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=context_manager,
    )

    events = []
    async for event in runner.run_turn(session):
        events.append(event)

    if not isinstance(events[0], ContextBuiltEvent):
        raise AssertionError(f"Expected first event to be ContextBuiltEvent, got: {events}")
    if not isinstance(events[1], SkillActivatedEvent):
        raise AssertionError(f"Expected skill event after context build, got: {events}")
    if events[1].skill_name != "demo" or events[1].source != "project":
        raise AssertionError(f"Unexpected skill event payload: {events[1]}")

    first_delta = next(index for index, event in enumerate(events) if isinstance(event, AssistantDeltaEvent))
    if first_delta <= 0:
        raise AssertionError(f"Expected assistant delta after skill event, got: {events}")
    if context_manager.selected_messages != ["please use $demo"]:
        raise AssertionError(f"Expected one turn-level skill selection, got: {context_manager.selected_messages}")


@pytest.mark.asyncio
async def test_skill_activation_event_emitted_once_per_turn() -> None:
    mock_client = AsyncMock()

    async def mock_stream(*args, **kwargs):
        yield MagicMock()

    mock_client.stream = mock_stream

    consume_count = 0

    async def mock_consume(*args, **kwargs):
        nonlocal consume_count
        consume_count += 1
        on_content_async = args[1]
        await on_content_async("Hello")
        if consume_count == 1:
            return "Hello", [ParsedToolCall(call_id="call_1", name="write_file", raw_args="{}")]
        return "Hello", []

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume

    skill = _skill()
    match = SkillMatch(skill=skill, reason="explicit_dollar_name", score=100)
    context_manager = FakeContextManager([match])
    session = FakeSession("please use $demo")

    async def execute(*args, **kwargs):
        yield MagicMock()

    mock_processor = MagicMock()
    mock_processor.execute = execute

    runner = AsyncTurnRunner(
        chat_client=mock_client,
        tool_processor=mock_processor,
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=context_manager,
    )

    events = []
    async for event in runner.run_turn(session):
        events.append(event)

    skill_events = [event for event in events if isinstance(event, SkillActivatedEvent)]
    if len(skill_events) != 1:
        raise AssertionError(f"Expected one skill event per turn, got: {skill_events}")
    if context_manager.selected_messages != ["please use $demo"]:
        raise AssertionError(f"Expected skill selection once, got: {context_manager.selected_messages}")
    if len(context_manager.build_active_matches) < 2:
        raise AssertionError(f"Expected multiple context builds due to tool call, got: {context_manager.build_active_matches}")
    if any(matches != [match] for matches in context_manager.build_active_matches):
        raise AssertionError(f"Expected same active skill matches on each build, got: {context_manager.build_active_matches}")


@pytest.mark.asyncio
async def test_plain_trigger_does_not_emit_skill_activation_event() -> None:
    mock_client = AsyncMock()

    async def mock_stream(*args, **kwargs):
        yield MagicMock()

    mock_client.stream = mock_stream

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        await on_content_async("Hello")
        return "Hello", []

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume
    context_manager = FakeContextManager([])
    session = FakeSession("demo trigger")

    runner = AsyncTurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=context_manager,
    )

    events = []
    async for event in runner.run_turn(session):
        events.append(event)

    skill_events = [event for event in events if isinstance(event, SkillActivatedEvent)]
    if skill_events:
        raise AssertionError(f"Expected no skill activation events, got: {skill_events}")
    if context_manager.selected_messages != ["demo trigger"]:
        raise AssertionError(f"Expected one turn-level skill selection, got: {context_manager.selected_messages}")
    if context_manager.build_active_matches != [[]]:
        raise AssertionError(f"Expected no active skill matches, got: {context_manager.build_active_matches}")


def main() -> int:
    import asyncio

    asyncio.run(test_skill_activation_event_precedes_assistant_delta())
    asyncio.run(test_skill_activation_event_emitted_once_per_turn())
    asyncio.run(test_plain_trigger_does_not_emit_skill_activation_event())
    print("Skill activation event tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
