"""Team delegation lifecycle tests."""

from __future__ import annotations

import json
import asyncio
import shutil
import sys
from contextvars import Context
from pathlib import Path
from types import SimpleNamespace

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain import AssistantMessageCompletedEvent
from agent.bootstrap.delegation import TeamDelegator
from agent.infrastructure.planning.store import (
    preserve_active_session_context,
    resolve_session_base,
    set_active_session_context,
)
from agent.infrastructure.team import initialize_team_project


class _ParentSession:
    session_id = "parent-session"


class _ChildRuntime:
    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[dict] = []

    async def run_turn(self, **kwargs):
        self.calls.append(kwargs)
        yield AssistantMessageCompletedEvent(content=self.response)


def _project_with_researcher(tmp_path: Path, monkeypatch) -> tuple[object, Path]:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    project_root = tmp_path / "project"
    project_root.mkdir()
    project = initialize_team_project(project_root, project_id="quant-project")
    source = project_root / "agents" / "main-agent"
    researcher = project_root / "agents" / "researcher"
    shutil.copytree(source, researcher)
    manifest = researcher / ".aiteam" / "agent.yaml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8")
        .replace("id: main-agent", "id: researcher")
        .replace("name: Main Agent", "name: Researcher"),
        encoding="utf-8",
    )
    return project, project_root


@pytest.mark.asyncio
async def test_execute_creates_a_target_bound_child_session(tmp_path: Path, monkeypatch) -> None:
    project, project_root = _project_with_researcher(tmp_path, monkeypatch)
    (project_root / "shared" / "result.md").write_text("done", encoding="utf-8")
    captured: list[dict] = []
    runtime = _ChildRuntime(
        json.dumps(
            {
                "status": "completed",
                "summary": "Research complete.",
                "published_paths": ["shared/result.md"],
            }
        )
    )

    def builder(**kwargs):
        captured.append(kwargs)
        return SimpleNamespace(runtime=runtime, session_store=SimpleNamespace(session_id="child-session"))

    delegator = TeamDelegator(
        project=project,
        parent_session=_ParentSession(),
        settings=object(),
        provider_client_factory=object(),
        session_dir=str(tmp_path / "sessions"),
        container_builder=builder,
    )

    result = json.loads(await delegator.delegate("researcher", "Do the research."))

    assert result["ok"] is True
    assert result["data"] == {
        "agent_id": "researcher",
        "status": "completed",
        "summary": "Research complete.",
        "published_paths": ["shared/result.md"],
        "session_id": "child-session",
    }
    assert captured[0]["workspace_root"] == str(project_root / "agents" / "researcher")
    assert captured[0]["project_id"] == "quant-project"
    assert captured[0]["owner_agent_id"] == "researcher"
    assert captured[0]["session_type"] == "delegated_task"
    assert captured[0]["parent_session_id"] == "parent-session"
    assert captured[0]["lock_workspace"] is False
    assert runtime.calls[0]["query"] == "Do the research."
    execute_prompt = runtime.calls[0]["transient_system_messages"][0]["content"]
    assert "intentional, reusable deliverables" in execute_prompt
    assert "Do not list private workspace files" in execute_prompt
    assert "empty published_paths list" in execute_prompt


@pytest.mark.asyncio
async def test_inspect_uses_a_temporary_session_and_returns_no_session_id(tmp_path: Path, monkeypatch) -> None:
    project, _ = _project_with_researcher(tmp_path, monkeypatch)
    captured: list[dict] = []
    runtime = _ChildRuntime('{"status":"blocked","summary":"Waiting for data.","published_paths":[]}')

    def builder(**kwargs):
        captured.append(kwargs)
        assert Path(kwargs["session_dir"]).is_dir()
        return SimpleNamespace(
            runtime=runtime,
            session_store=SimpleNamespace(session_id="temporary"),
        )

    delegator = TeamDelegator(
        project=project,
        parent_session=_ParentSession(),
        settings=object(),
        provider_client_factory=object(),
        session_dir=str(tmp_path / "sessions"),
        container_builder=builder,
    )

    result = json.loads(await delegator.delegate("researcher", "What is the status?", "inspect"))

    assert result["ok"] is True
    assert result["data"]["status"] == "blocked"
    assert "session_id" not in result["data"]
    assert captured[0]["session_type"] == "inspect"
    assert captured[0]["enabled_tools"] == ("read_file", "glob", "grep", "skill")
    inspect_prompt = runtime.calls[0]["transient_system_messages"][0]["content"]
    assert "do not modify files, create output files" in inspect_prompt
    assert "existing shared files" in inspect_prompt
    assert "empty published_paths list" in inspect_prompt
    assert not Path(captured[0]["session_dir"]).exists()


@pytest.mark.asyncio
async def test_delegate_rejects_the_main_agent_and_unknown_target(tmp_path: Path, monkeypatch) -> None:
    project, _ = _project_with_researcher(tmp_path, monkeypatch)
    delegator = TeamDelegator(
        project=project,
        parent_session=_ParentSession(),
        settings=object(),
        provider_client_factory=object(),
        session_dir=None,
        container_builder=lambda **kwargs: None,
    )

    main_result = json.loads(await delegator.delegate("main-agent", "Do it."))
    missing_result = json.loads(await delegator.delegate("missing", "Do it."))

    assert main_result["ok"] is False
    assert main_result["error_type"] == "InvalidAgent"
    assert missing_result["ok"] is False
    assert missing_result["error_type"] == "InvalidAgent"


@pytest.mark.asyncio
async def test_delegate_allows_concurrent_calls_to_the_same_agent(tmp_path: Path, monkeypatch) -> None:
    project, _ = _project_with_researcher(tmp_path, monkeypatch)
    entered = 0
    both_entered = asyncio.Event()

    class ConcurrentRuntime:
        async def run_turn(self, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 2:
                both_entered.set()
            await both_entered.wait()
            yield AssistantMessageCompletedEvent(content='{"status":"completed","summary":"done","published_paths":[]}')

    captured: list[dict] = []
    runtime = ConcurrentRuntime()

    def builder(**kwargs):
        captured.append(kwargs)
        return SimpleNamespace(
            runtime=runtime,
            session_store=SimpleNamespace(session_id=f"child-{len(captured)}"),
        )

    delegator = TeamDelegator(
        project=project,
        parent_session=_ParentSession(),
        settings=object(),
        provider_client_factory=object(),
        session_dir=None,
        container_builder=builder,
    )

    results = await asyncio.wait_for(
        asyncio.gather(
            delegator.delegate("researcher", "Inspect the workspace."),
            delegator.delegate("researcher", "Inspect the workspace again."),
        ),
        timeout=1,
    )

    assert [json.loads(result)["ok"] for result in results] == [True, True]
    assert len(captured) == 2


def test_nested_child_session_context_restores_the_parent_plan_target(tmp_path: Path) -> None:
    session_root = tmp_path / "sessions"
    parent_id = "parent-session"
    child_id = "child-session"
    (session_root / parent_id).mkdir(parents=True)
    (session_root / child_id).mkdir()

    def exercise() -> None:
        set_active_session_context(str(session_root), parent_id)

        with preserve_active_session_context():
            set_active_session_context(str(session_root), child_id)
            child_base, active_child = resolve_session_base()
            assert child_base == session_root / child_id
            assert active_child == child_id

        parent_base, active_parent = resolve_session_base()
        assert parent_base == session_root / parent_id
        assert active_parent == parent_id

    Context().run(exercise)
