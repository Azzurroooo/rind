import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import ContextManager


class QueryOnlySession:
    def __init__(self, messages, catalog=None):
        self._messages = [dict(message) for message in messages]
        self._catalog = list(catalog or [])

    async def get_messages_slice(self, start=None, end=None, roles=None):
        messages = [dict(message) for message in self._messages]
        if roles:
            messages = [message for message in messages if message.get("role") in set(roles)]
        return messages[slice(start, end)]

    async def get_skill_catalog(self):
        return [dict(entry) for entry in self._catalog]

    async def get_compact_generation(self):
        return 1

    async def get_latest_assistant_sampling_usage(self):
        return {}


@pytest.mark.asyncio
async def test_context_manager_injects_catalog_after_docs_and_transient_context() -> None:
    session = QueryOnlySession(
        [{"role": "system", "content": "base"}, {"role": "user", "content": "hello"}],
        [
            {"name": "zeta", "description": "Zeta workflow", "scope": "project"},
            {"name": "alpha", "description": "Alpha workflow", "scope": "user"},
        ],
    )

    def docs_provider():
        return ([{"role": "system", "content": "rind docs"}], {}, {})

    result = await ContextManager(rind_doc_provider=docs_provider).build_messages_async(
        session,
        transient_system_messages=[{"role": "system", "content": "temporary"}],
    )

    contents = [message["content"] for message in result.messages]
    assert contents[0] == "base"
    assert contents[1] == "rind docs"
    assert contents[2] == "temporary"
    assert contents[3].startswith("<available_skills>")
    assert contents[3].index('name="alpha"') < contents[3].index('name="zeta"')
    assert contents[4] == "hello"
    assert result.decisions["skill_catalog_injected"] is True


@pytest.mark.asyncio
async def test_context_manager_does_not_add_catalog_to_persisted_history_or_empty_catalog() -> None:
    session = QueryOnlySession([{"role": "system", "content": "base"}, {"role": "user", "content": "hello"}])

    result = await ContextManager().build_messages_async(session)

    assert result.messages == session._messages
    assert result.stats["skill_count"] == 0
    assert result.decisions["skill_catalog_injected"] is False


@pytest.mark.asyncio
async def test_catalog_rendering_is_stable_and_respects_the_character_budget() -> None:
    catalog = [
        {"name": "alpha", "description": "a" * 1000, "scope": "project"},
        {"name": "beta", "description": "b" * 1000, "scope": "user"},
    ]
    session = QueryOnlySession([{"role": "system", "content": "base"}], catalog)
    manager = ContextManager(skill_catalog_char_limit=300)

    first = await manager.build_messages_async(session)
    second = await manager.build_messages_async(session)
    catalog_message = next(message for message in first.messages if message["content"].startswith("<available_skills>"))

    assert first.messages == second.messages
    assert len(catalog_message["content"]) <= 300
    assert "<available_skills>" not in session._messages[0]["content"]


@pytest.mark.asyncio
async def test_compaction_context_can_exclude_the_catalog() -> None:
    session = QueryOnlySession(
        [{"role": "system", "content": "base"}, {"role": "user", "content": "hello"}],
        [{"name": "demo", "description": "Demo", "scope": "project"}],
    )

    result = await ContextManager().build_messages_async(session, include_skill_catalog=False)

    assert result.messages == session._messages
    assert result.decisions["skill_catalog_injected"] is False
