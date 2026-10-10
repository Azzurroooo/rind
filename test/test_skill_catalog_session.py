import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import SkillTurnCoordinator
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.persistence.session_meta import new_session_id, normalize_skill_catalog, normalize_skill_sources
from agent.infrastructure.skills import SkillRepository


def _repository(tmp_path: Path) -> SkillRepository:
    for root, name in ((tmp_path / "work" / ".rind" / "skills", "demo"), (tmp_path / "home" / ".claude" / "skills", "claude")):
        skill_file = root / name / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(f"---\nname: {name}\ndescription: {name} skill\n---\n\nBody\n", encoding="utf-8")
    hidden = tmp_path / "work" / ".rind" / "skills" / "manual" / "SKILL.md"
    hidden.parent.mkdir(parents=True)
    hidden.write_text("---\ndescription: Manual\ndisable-model-invocation: true\n---\n", encoding="utf-8")
    return SkillRepository(tmp_path / "work", home=tmp_path / "home", rind_home=tmp_path / "rind")


async def _saved_session(tmp_path: Path) -> JsonlSessionStore:
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="system")
    await session.initialize()
    await session.persist_user_input("hello")
    return session


@pytest.mark.asyncio
async def test_catalog_follows_the_session_import_choice_and_hides_manual_skills(tmp_path: Path) -> None:
    session = await _saved_session(tmp_path)
    skills = SkillTurnCoordinator(_repository(tmp_path), catalog=True)

    await skills.sync_catalog(session)
    names = [entry["name"] for entry in await session.get_skill_catalog()]
    await session.set_skill_sources({"claude_user": False})
    await skills.sync_catalog(session)

    assert names == ["claude", "demo", "skill-creator"]
    assert [entry["name"] for entry in await session.get_skill_catalog()] == ["demo", "skill-creator"]


@pytest.mark.asyncio
async def test_a_session_that_cannot_read_files_gets_no_catalog(tmp_path: Path) -> None:
    session = await _saved_session(tmp_path)

    await SkillTurnCoordinator(_repository(tmp_path), catalog=False).sync_catalog(session)

    assert await session.get_skill_catalog() == []


@pytest.mark.asyncio
async def test_repeated_catalog_sync_does_not_write_when_entries_are_unchanged(tmp_path: Path) -> None:
    session = await _saved_session(tmp_path)
    skills = SkillTurnCoordinator(_repository(tmp_path), catalog=True)
    await skills.sync_catalog(session)

    writes = []
    original = session._persist_meta_sync
    session._persist_meta_sync = lambda *args, **kwargs: (writes.append(True), original(*args, **kwargs))[1]
    await skills.sync_catalog(session)

    assert writes == []


@pytest.mark.asyncio
async def test_skill_sources_chosen_before_the_first_message_are_saved_with_it(tmp_path: Path) -> None:
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=new_session_id(), system_prompt="system")
    await session.create_session(session_id=session.session_id)

    await session.set_skill_sources({"codex_project": False})
    assert not (tmp_path / "sessions").exists()
    await session.persist_user_input("hello")
    reopened = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=session.session_id)
    await reopened.initialize()

    assert (await reopened.get_skill_sources())["codex_project"] is False


def test_catalog_normalization_keeps_only_valid_structured_entries() -> None:
    assert normalize_skill_catalog(
        [
            {"name": "demo", "description": "Demo", "location": "/s/demo/SKILL.md"},
            {"name": "bad/name", "description": "Bad", "location": "/s/bad/SKILL.md"},
            {"name": "other", "description": "Bad\nDescription", "location": "/s/other/SKILL.md"},
            {"name": "legacy", "description": "No location", "scope": "project"},
            {"name": "Demo", "description": "Duplicate", "location": "/s/dup/SKILL.md"},
        ]
    ) == [{"name": "demo", "description": "Demo", "location": "/s/demo/SKILL.md"}]


def test_skill_sources_default_to_every_import_layer() -> None:
    assert normalize_skill_sources(None) == {
        "claude_user": True, "codex_user": True, "claude_project": True, "codex_project": True,
    }
    assert normalize_skill_sources({"claude_user": False, "unknown": False})["claude_user"] is False
