import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.models import ModelStreamEvent
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.persistence.session_meta import normalize_skill_sources
from agent.infrastructure.skills import SkillRepository, install_system_skills
from agent.runtime.server.commands import SlashCommandContext, SlashCommandRouter
from agent.runtime.server.commands.catalog import build_command_infos
from agent.runtime.server.dispatcher import RuntimeDispatcher
from agent.runtime.server.worker import RuntimeWorker


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
    install_system_skills(tmp_path / "rind")
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

    session = Session()
    session.sources = normalize_skill_sources({"claude_user": True})
    result = await _run("/skill", _context(tmp_path, session))
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
async def test_the_users_own_claude_skills_are_one_off_line_by_default(tmp_path: Path) -> None:
    _skill(tmp_path / "home" / ".claude" / "skills", "only")

    result = await _run("/skill", _context(tmp_path))

    assert "Claude · user  off" in result.text and "1 skill(s)" in result.text
    assert "only skill" not in result.text


@pytest.mark.asyncio
async def test_import_switches_a_layer_and_refreshes_a_hosted_catalog(tmp_path: Path) -> None:
    _skill(tmp_path / "home" / ".agents" / "skills", "codex")
    session, runtime = Session(), Runtime()

    result = await _run("/import codex_user=on", _context(tmp_path, session, runtime))

    assert session.sources["codex_user"] is True
    assert runtime.synced == 1
    assert "cannot reuse the prompt cache" in result.text
    codex = next(source for source in result.display["sources"] if source["id"] == "codex_user")
    assert codex == {
        "id": "codex_user", "label": "Codex · user",
        "paths": [str(tmp_path / "home" / ".codex" / "skills"), str(tmp_path / "home" / ".agents" / "skills")],
        "count": 1, "enabled": True,
    }


@pytest.mark.asyncio
async def test_import_before_the_first_message_reads_the_window_choice_and_cannot_change_it(tmp_path: Path) -> None:
    draft_session = Session(session_id=None)
    listed = await _run("/import", _context(tmp_path, draft_session, draft={"skill_sources": {"claude_project": False}}))
    changed = await _run("/import claude_user=off", _context(tmp_path, draft_session))

    assert [source["enabled"] for source in listed.display["sources"]] == [False, False, False, True]
    assert "Send your first message" in changed.text


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", ["claude", "claude_user=maybe", "rind_user=off"])
async def test_import_rejects_unknown_sources_and_values(tmp_path: Path, arguments: str) -> None:
    session = Session()

    result = await _run(f"/import {arguments}", _context(tmp_path, session))

    assert result.text.startswith("Usage: /import")
    assert session.sources == normalize_skill_sources(None)


@pytest.mark.asyncio
async def test_a_runtime_conversation_keeps_its_import_choice_from_the_window_to_the_catalog(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    _skill(tmp_path / "home" / ".claude" / "skills", "claude-only")

    async def stream(*args, **kwargs):
        yield ModelStreamEvent(kind="text_delta", text="done")
        yield ModelStreamEvent(kind="completed", stop_reason="stop")

    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", AsyncMock(return_value=SimpleNamespace(stream=stream, close=AsyncMock())))
    messages = []

    async def send(payload):
        messages.append(payload)

    server = RuntimeDispatcher(worker, writer=SimpleNamespace(send=send))

    async def request(method, **params):
        await server.dispatch({"request_id": method, "method": method, "params": params})
        response = next(message for message in reversed(messages) if message.get("request_id") == method)
        assert "error" not in response, response
        return response["result"]

    def catalog_names(session_id):
        meta = JsonlSessionStore.load_session_metadata(session_id, str(tmp_path / "sessions"))
        return [entry["name"] for entry in meta["skill_catalog"]]

    try:
        await request("initialize")
        default = await request("rind/command/execute", input="/import", workspace_root=str(tmp_path))
        assert [source["enabled"] for source in default["display"]["sources"]] == [False, False, True, True]
        choice = {"claude_user": True}
        listed = await request("rind/command/execute", input="/import", workspace_root=str(tmp_path), draft={"skill_sources": choice})
        assert [source["enabled"] for source in listed["display"]["sources"]][0] is True
        session_id = (await request("session/create", workspace_root=str(tmp_path), skill_sources=choice))["session_id"]
        await request("session/prompt", session_id=session_id, input="hello")
        assert catalog_names(session_id) == ["claude-only", "skill-creator"], "the window's choice reaches the first message's catalog"

        updated = await request("rind/command/execute", session_id=session_id, input="/import claude_user=off")
        assert "cannot reuse the prompt cache" in updated["text"]
        await request("session/prompt", session_id=session_id, input="again")
        assert catalog_names(session_id) == ["skill-creator"]
        listing = await request("rind/command/execute", session_id=session_id, input="/skill")
        claude = next(source for source in listing["display"]["sources"] if source["label"] == "Claude · user")
        assert [skill["status"] for skill in claude["skills"]] == ["off"]
    finally:
        server.close()
        await worker.close()
