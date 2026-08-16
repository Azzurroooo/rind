import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.core import AgentRuntime
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.persistence.session_meta import normalize_skill_catalog
from agent.infrastructure.skills import SkillRepository


class MinimalRunner:
    def set_model(self, model):
        self.model = model

    def set_retry_callback(self, callback):
        self.retry_callback = callback

    def set_user_question_responder(self, responder):
        self.responder = responder


def _write_skill(root: Path, name: str, description: str) -> None:
    skill_file = root / name / "SKILL.md"
    skill_file.parent.mkdir(parents=True)
    skill_file.write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nBody\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_runtime_initialization_keeps_skill_catalog_in_memory_for_draft(tmp_path: Path) -> None:
    project_skills = tmp_path / "project" / ".rind" / "skills"
    _write_skill(project_skills, "demo", "Demo skill")
    repository = SkillRepository(
        project_skill_dir=str(project_skills),
        user_skill_dir=str(tmp_path / "user"),
    )
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="system")
    runtime = AgentRuntime(MinimalRunner(), session, skill_repository=repository)

    await runtime.initialize()
    assert session.session_id is None
    assert await session.get_skill_catalog() == []
    assert not (tmp_path / "sessions").exists()


@pytest.mark.asyncio
async def test_catalog_update_does_not_materialize_draft(tmp_path: Path) -> None:
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="system")
    await session.initialize()

    await session.set_skill_catalog([{"name": "demo", "description": "Demo", "scope": "project"}])

    assert session.session_id is None
    assert not (tmp_path / "sessions").exists()


@pytest.mark.asyncio
async def test_repeated_catalog_sync_does_not_write_when_entries_are_unchanged(tmp_path: Path) -> None:
    project_skills = tmp_path / "project" / ".rind" / "skills"
    _write_skill(project_skills, "demo", "Demo skill")
    repository = SkillRepository(project_skill_dir=str(project_skills), user_skill_dir=str(tmp_path / "user"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"))
    runtime = AgentRuntime(MinimalRunner(), session, skill_repository=repository)
    await runtime.initialize()

    writes = []
    original = session._persist_meta_sync
    session._persist_meta_sync = lambda *args, **kwargs: (writes.append(True), original(*args, **kwargs))[1]
    await runtime._sync_skill_catalog()

    assert writes == []


def test_catalog_normalization_keeps_only_valid_structured_entries() -> None:
    assert normalize_skill_catalog(
        [
            {"name": "demo", "description": "Demo", "scope": "PROJECT"},
            {"name": "bad/name", "description": "Bad", "scope": "project"},
            {"name": "other", "description": "Bad\nDescription", "scope": "project"},
            {"name": "agent-only", "description": "Agent", "scope": "agent"},
            {"name": "agent-only", "description": "Duplicate", "scope": "user"},
        ]
    ) == [
        {"name": "agent-only", "description": "Agent", "scope": "agent"},
        {"name": "demo", "description": "Demo", "scope": "project"},
    ]
