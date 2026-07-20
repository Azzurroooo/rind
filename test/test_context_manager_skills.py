import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pytest

from agent.application.services import ContextManager, SkillSelector
from agent.domain import Skill, SkillMatch


class QueryOnlySession:
    def __init__(self, messages):
        self._messages = [dict(message) for message in messages]

    async def get_messages_slice(self, start=None, end=None, roles=None):
        messages = [dict(message) for message in self._messages]
        if roles:
            allowed = set(roles)
            messages = [message for message in messages if message.get("role") in allowed]
        return messages[slice(start, end)]


class StaticSkillRepository:
    def __init__(self, skills):
        self._skills = list(skills)

    def list_skills(self):
        return list(self._skills)


def _skill(name: str = "demo") -> Skill:
    return Skill(
        name=name,
        description="Demo skill for tests.",
        body="# Demo\nFollow demo instructions.",
        path=f"/tmp/{name}/SKILL.md",
        triggers=["demo trigger"],
        source="project",
    )


@pytest.mark.asyncio
async def test_context_manager_does_not_inject_when_no_skills() -> None:
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ])
    manager = ContextManager(skill_repository=StaticSkillRepository([]), skill_selector=SkillSelector())

    result = await manager.build_messages_async(session=session)

    if result.messages != session._messages:
        raise AssertionError(f"Expected unchanged messages, got: {result.messages}")
    if result.stats.get("skill_count") != 0:
        raise AssertionError(f"Unexpected skill stats: {result.stats}")
    if result.decisions.get("skill_injection_applied") is not False:
        raise AssertionError(f"Unexpected skill decisions: {result.decisions}")


@pytest.mark.asyncio
async def test_context_manager_skips_index_without_active_body() -> None:
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ])
    manager = ContextManager(skill_repository=StaticSkillRepository([_skill()]), skill_selector=SkillSelector())

    result = await manager.build_messages_async(session=session)

    if result.messages != session._messages:
        raise AssertionError(f"Expected no skill context without active skill, got: {result.messages}")
    if any("Active skill instructions:" in message.get("content", "") for message in result.messages):
        raise AssertionError(f"Did not expect active body, got: {result.messages}")
    if result.stats.get("skill_count") != 1 or result.stats.get("active_skill_count") != 0:
        raise AssertionError(f"Unexpected skill stats: {result.stats}")
    if result.stats.get("skill_index_chars") != 0:
        raise AssertionError(f"Expected no skill index chars, got: {result.stats}")
    if result.decisions.get("skills_available") is not True or result.decisions.get("skill_injection_applied") is not False:
        raise AssertionError(f"Unexpected skill decisions: {result.decisions}")


@pytest.mark.asyncio
async def test_context_manager_injects_active_skill_body() -> None:
    skill = _skill()
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "please use $demo"},
    ])
    manager = ContextManager(skill_repository=StaticSkillRepository([skill]), skill_selector=SkillSelector())
    match = SkillMatch(skill=skill, reason="explicit_dollar_name", score=100)

    result = await manager.build_messages_async(session=session, active_skill_matches=[match])

    contents = [message.get("content", "") for message in result.messages]
    if any(content.startswith("Available skills:") for content in contents):
        raise AssertionError(f"Did not expect skill index, got: {result.messages}")
    if not any("Active skill instructions:" in content and "Follow demo instructions." in content for content in contents):
        raise AssertionError(f"Expected active skill body, got: {result.messages}")
    if result.stats.get("active_skill_count") != 1 or result.stats.get("skill_index_chars") != 0:
        raise AssertionError(f"Unexpected active skill stats: {result.stats}")
    if result.decisions.get("skill_injection_applied") is not True:
        raise AssertionError(f"Expected active skill injection, got: {result.decisions}")
    active = result.decisions.get("active_skills")
    if not active or active[0].get("name") != "demo":
        raise AssertionError(f"Unexpected active skill decisions: {result.decisions}")


@pytest.mark.asyncio
async def test_context_manager_injects_tangerine_docs_before_transient_and_skill() -> None:
    skill = _skill()
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "please use $demo"},
    ])
    match = SkillMatch(skill=skill, reason="explicit_dollar_name", score=100)

    def docs_provider():
        return (
            [{"role": "system", "content": "\n\n--- project-doc ---\n\nproject guidance"}],
            {"tangerine_docs_injected_chars": 16},
            {"tangerine_docs_injected": True},
        )

    manager = ContextManager(
        skill_repository=StaticSkillRepository([skill]),
        skill_selector=SkillSelector(),
        tangerine_doc_provider=docs_provider,
    )

    result = await manager.build_messages_async(
        session=session,
        active_skill_matches=[match],
        transient_system_messages=[{"role": "system", "content": "init guidance"}],
    )

    contents = [message.get("content", "") for message in result.messages]
    assert contents[0] == "sys"
    assert contents[1].startswith("\n\n--- project-doc ---")
    assert contents[2] == "init guidance"
    assert "Active skill instructions:" in contents[3]
    assert contents[4] == "please use $demo"
    assert result.decisions["tangerine_docs_injected"] is True
    assert result.decisions["skill_injection_applied"] is True


@pytest.mark.asyncio
async def test_context_manager_does_not_parse_user_trigger() -> None:
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "demo trigger"},
    ])
    manager = ContextManager(skill_repository=StaticSkillRepository([_skill()]), skill_selector=SkillSelector())

    result = await manager.build_messages_async(session=session)

    contents = [message.get("content", "") for message in result.messages]
    if any(content.startswith("Available skills:") for content in contents):
        raise AssertionError(f"Did not expect skill index from trigger text, got: {result.messages}")
    if any("Active skill instructions:" in content for content in contents):
        raise AssertionError(f"Did not expect active skill body from trigger text, got: {result.messages}")
    if result.stats.get("active_skill_count") != 0:
        raise AssertionError(f"Unexpected active skill stats: {result.stats}")


def test_context_manager_selects_active_skills_for_turn_explicitly() -> None:
    manager = ContextManager(skill_repository=StaticSkillRepository([_skill()]), skill_selector=SkillSelector())

    explicit_matches = manager.select_active_skills_for_turn("please use $demo")
    implicit_matches = manager.select_active_skills_for_turn("demo trigger")

    if [match.skill.name for match in explicit_matches] != ["demo"]:
        raise AssertionError(f"Expected explicit skill match, got: {explicit_matches}")
    if implicit_matches:
        raise AssertionError(f"Expected no implicit trigger match, got: {implicit_matches}")


def main() -> int:
    import asyncio

    async def _run_all():
        await test_context_manager_does_not_inject_when_no_skills()
        await test_context_manager_skips_index_without_active_body()
        await test_context_manager_injects_active_skill_body()
        await test_context_manager_injects_tangerine_docs_before_transient_and_skill()
        await test_context_manager_does_not_parse_user_trigger()
        test_context_manager_selects_active_skills_for_turn_explicitly()

    asyncio.run(_run_all())
    print("ContextManager skill tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
