import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence.session_meta import normalize_skill_sources
from agent.infrastructure.skills import SkillRepository
from agent.runtime.server.commands import SlashCommandContext, SlashCommandRouter
from agent.runtime.server.commands.catalog import build_command_infos


class Session:
    def __init__(self, session_id="session_1"):
        self.session_id = session_id
        self.sources = normalize_skill_sources(None)

    async def get_skill_sources(self):
        return self.sources

    async def set_skill_sources(self, sources):
        self.sources = normalize_skill_sources(sources)


class Runtime:
    synced = 0

    async def sync_skill_catalog(self):
        self.synced += 1


def _skill(root: Path, name: str, extra: str = "") -> Path:
    skill_file = root / name / "SKILL.md"
    skill_file.parent.mkdir(parents=True, exist_ok=True)
    skill_file.write_text(f"---\nname: {name}\ndescription: {name} skill\n{extra}---\n\nBody\n", encoding="utf-8")
    return skill_file


def _context(tmp_path: Path, session=None, runtime=None, draft=None) -> SlashCommandContext:
    repository = SkillRepository(tmp_path / "work", home=tmp_path / "home", rind_home=tmp_path / "rind")
    return SlashCommandContext(runtime=runtime, session=session or Session(), draft=draft, skills=repository)


async def _run(text: str, context: SlashCommandContext):
    return await SlashCommandRouter(build_command_infos()).execute(text, context)


@pytest.mark.asyncio
async def test_skill_groups_layers_and_marks_overrides_hidden_skills_and_problems(tmp_path: Path) -> None:
    claude = _skill(tmp_path / "home" / ".claude" / "skills", "shared")
    rind = _skill(tmp_path / "work" / ".rind" / "skills", "shared")
    _skill(tmp_path / "work" / ".rind" / "skills", "manual", "disable-model-invocation: true\n")
    broken = tmp_path / "work" / ".rind" / "skills" / "broken" / "SKILL.md"
    broken.parent.mkdir(parents=True)
    broken.write_text("---\nname: broken\n---\n", encoding="utf-8")

    result = await _run("/skill", _context(tmp_path))
    sources = {source["label"]: source for source in result.display["sources"]}

    assert sources["Claude · user"]["skills"] == [
        {"name": "shared", "description": "shared skill", "status": "overridden", "overridden_by": str(rind.resolve())},
    ]
    statuses = {skill["name"]: skill["status"] for skill in sources["Rind · project"]["skills"]}
    assert statuses == {"manual": "hidden", "shared": "active"}
    assert result.display["problems"] == [{"location": str(broken), "message": "missing description."}]
    assert f"overridden by {rind.resolve()}" in result.text
    assert str(claude.parent.parent) in result.text


@pytest.mark.asyncio
async def test_skill_shows_a_switched_off_layer_as_one_line(tmp_path: Path) -> None:
    _skill(tmp_path / "home" / ".claude" / "skills", "only")
    session = Session()
    session.sources = normalize_skill_sources({"claude_user": False})

    result = await _run("/skill", _context(tmp_path, session))

    assert "Claude · user  off" in result.text and "1 skill(s)" in result.text
    assert "only skill" not in result.text


@pytest.mark.asyncio
async def test_import_switches_a_layer_and_refreshes_a_hosted_catalog(tmp_path: Path) -> None:
    _skill(tmp_path / "home" / ".agents" / "skills", "codex")
    session, runtime = Session(), Runtime()

    result = await _run("/import codex_user=off", _context(tmp_path, session, runtime))

    assert session.sources["codex_user"] is False
    assert runtime.synced == 1
    assert "cannot reuse the prompt cache" in result.text
    codex = next(source for source in result.display["sources"] if source["id"] == "codex_user")
    assert codex == {
        "id": "codex_user", "label": "Codex · user",
        "paths": [str(tmp_path / "home" / ".codex" / "skills"), str(tmp_path / "home" / ".agents" / "skills")],
        "count": 1, "enabled": False,
    }


@pytest.mark.asyncio
async def test_import_before_the_first_message_reads_the_window_choice_and_cannot_change_it(tmp_path: Path) -> None:
    draft_session = Session(session_id=None)
    listed = await _run("/import", _context(tmp_path, draft_session, draft={"skill_sources": {"claude_project": False}}))
    changed = await _run("/import claude_user=off", _context(tmp_path, draft_session))

    assert [source["enabled"] for source in listed.display["sources"]] == [True, True, False, True]
    assert "Send your first message" in changed.text


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", ["claude", "claude_user=maybe", "rind_user=off"])
async def test_import_rejects_unknown_sources_and_values(tmp_path: Path, arguments: str) -> None:
    session = Session()

    result = await _run(f"/import {arguments}", _context(tmp_path, session))

    assert result.text.startswith("Usage: /import")
    assert session.sources == normalize_skill_sources(None)
