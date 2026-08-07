import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import SkillInvocationParser, SkillTurnCoordinator
from agent.infrastructure.skills import SkillRepository


class RecordingSession:
    def __init__(self):
        self.messages = []

    async def persist_message(self, role, content, **kwargs):
        self.messages.append({"role": role, "content": content, **kwargs})


def _repository(tmp_path: Path) -> SkillRepository:
    root = tmp_path / "skills"
    for name in ("alpha", "beta"):
        skill_file = root / name / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(
            f"---\nname: {name}\ndescription: {name} description\n---\n\n{name} body\n",
            encoding="utf-8",
        )
    return SkillRepository(project_skill_dir=str(root), user_skill_dir=str(tmp_path / "user"))


def test_skill_invocation_parser_preserves_first_occurrence_order_and_deduplicates() -> None:
    invocations = SkillInvocationParser().parse(" /skill:beta solve this with $alpha and $beta and $unknown")

    assert [(item.name, item.syntax) for item in invocations] == [
        ("beta", "slash"),
        ("alpha", "dollar"),
        ("unknown", "dollar"),
    ]


@pytest.mark.asyncio
async def test_unknown_slash_skill_fails_before_the_user_message_is_persisted(tmp_path: Path) -> None:
    session = RecordingSession()
    coordinator = SkillTurnCoordinator(_repository(tmp_path))

    with pytest.raises(ValueError, match="Unknown Skill: missing"):
        await coordinator.persist_user_input(session, "/skill:missing do work")

    assert session.messages == []


@pytest.mark.asyncio
async def test_explicit_skill_snapshots_follow_the_original_user_message(tmp_path: Path) -> None:
    session = RecordingSession()
    coordinator = SkillTurnCoordinator(_repository(tmp_path))

    invocations = await coordinator.persist_user_input(session, "/skill:beta solve with $alpha and $unknown")

    assert [(item.name, item.syntax) for item in invocations] == [("beta", "slash"), ("alpha", "dollar")]
    assert [message["content"] for message in session.messages[:1]] == ["/skill:beta solve with $alpha and $unknown"]
    assert session.messages[0]["meta"]["skill_invocations"] == [
        {"name": "beta", "syntax": "slash"},
        {"name": "alpha", "syntax": "dollar"},
    ]
    assert [message["meta"]["kind"] for message in session.messages[1:]] == [
        "skill_snapshot",
        "skill_snapshot",
    ]
    assert "beta body" in session.messages[1]["content"]
    assert "alpha body" in session.messages[2]["content"]
