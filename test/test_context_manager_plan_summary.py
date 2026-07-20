import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

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
    def list_skills(self):
        return [
            Skill(
                name="demo",
                description="Demo skill.",
                body="# Demo",
                path="/tmp/demo/SKILL.md",
                source="project",
            )
        ]


class ChangingPlanProvider:
    def __init__(self):
        self.count = 0

    def build_context(self):
        self.count += 1
        content = f"Active plan summary:\n- Plan: p (version {self.count})"
        return (
            [{"role": "system", "content": content}],
            {
                "plan_summary_chars": len(content),
                "plan_open": True,
                "plan_step_count": 1,
                "plan_unfinished_step_count": 1,
            },
            {
                "plan_summary_injected": True,
                "plan_id": "p",
                "plan_version": self.count,
                "plan_state": "open",
            },
        )


@pytest.mark.asyncio
async def test_context_manager_does_not_inject_plan_summary_before_latest_user() -> None:
    provider = ChangingPlanProvider()
    manager = ContextManager(
        plan_context_provider=provider,
        skill_repository=StaticSkillRepository(),
        skill_selector=SkillSelector(),
    )
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "latest question"},
    ])

    result = await manager.build_messages_async(session=session)

    assert result.messages == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "latest question"},
    ]
    assert provider.count == 0
    assert result.stats["plan_summary_chars"] == 0
    assert result.decisions["plan_summary_injected"] is False
    assert result.decisions["plan_state"] == "none"


@pytest.mark.asyncio
async def test_context_manager_keeps_active_skill_after_system_without_plan_injection() -> None:
    provider = ChangingPlanProvider()
    skill = Skill(
        name="demo",
        description="Demo skill.",
        body="# Demo\nUse demo instructions.",
        path="/tmp/demo/SKILL.md",
        source="project",
    )
    manager = ContextManager(
        plan_context_provider=provider,
        skill_repository=StaticSkillRepository(),
        skill_selector=SkillSelector(),
    )
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "latest $demo question"},
    ])

    result = await manager.build_messages_async(
        session=session,
        active_skill_matches=[SkillMatch(skill=skill, reason="explicit_dollar_name", score=100)],
    )

    contents = [message.get("content", "") for message in result.messages]
    assert contents[0] == "sys"
    assert contents[1].startswith("Active skill instructions:")
    assert contents[-1] == "latest $demo question"
    assert all(not content.startswith("Active plan summary:") for content in contents)
    assert provider.count == 0


@pytest.mark.asyncio
async def test_context_manager_repeated_builds_keep_messages_stable_without_plan_reads() -> None:
    provider = ChangingPlanProvider()
    manager = ContextManager(plan_context_provider=provider)
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "latest question"},
    ])

    first = await manager.build_messages_async(session=session)
    second = await manager.build_messages_async(session=session)

    assert first.messages == second.messages
    assert first.messages == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "latest question"},
    ]
    assert provider.count == 0


@pytest.mark.asyncio
async def test_context_manager_does_not_inject_plan_without_user_message() -> None:
    provider = ChangingPlanProvider()
    manager = ContextManager(plan_context_provider=provider)
    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "assistant", "content": "assistant only"},
    ])

    result = await manager.build_messages_async(session=session)

    assert result.messages == [
        {"role": "system", "content": "sys"},
        {"role": "assistant", "content": "assistant only"},
    ]
    assert provider.count == 0


def main() -> int:
    import asyncio

    asyncio.run(test_context_manager_does_not_inject_plan_summary_before_latest_user())
    asyncio.run(test_context_manager_keeps_active_skill_after_system_without_plan_injection())
    asyncio.run(test_context_manager_repeated_builds_keep_messages_stable_without_plan_reads())
    asyncio.run(test_context_manager_does_not_inject_plan_without_user_message())
    print("ContextManager plan summary tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
