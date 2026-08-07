import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import AgentRuntimeState, ArtifactRef, Delivery, Message, OrganizationEvent
from agent.infrastructure.persistence.json_team_state_store import JsonTeamStateStore
from agent.infrastructure.team import initialize_team_project


def build_project(tmp_path: Path, monkeypatch, project_id: str = "quant-project"):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    root = tmp_path / project_id
    root.mkdir()
    return initialize_team_project(root, project_id=project_id)


def test_store_is_lazy_and_recovers_dynamic_team_facts(tmp_path: Path, monkeypatch) -> None:
    project = build_project(tmp_path, monkeypatch)
    store = JsonTeamStateStore(project)

    assert not store.root.exists()
    assert store.get_agent_state("main-agent").status == AgentRuntimeState(agent_id="main-agent").status

    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="user",
        recipient_id="main-agent",
        body="research",
        artifact_refs=(ArtifactRef(value="reports/brief.md"),),
    )
    store.append_message(message)
    store.append_delivery(Delivery(message_id=message.id, recipient_id="main-agent"))
    store.set_agent_status("main-agent", "paused")
    store.append_event(OrganizationEvent(type="message_queued", agent_id="main-agent", message_id=message.id))

    restored = JsonTeamStateStore(project)

    assert restored.root == (tmp_path / "rind_home" / "teams" / "quant-project").resolve()
    assert restored.get_message("msg_1") == message
    assert restored.get_delivery("msg_1", "main-agent").status == "pending"
    assert restored.get_agent_state("main-agent").status == "paused"
    assert restored.list_events()[0].type == "message_queued"
    assert not (restored.root / "agents.json").exists()
    assert not (restored.root / "agent_configs.json").exists()
    assert not (restored.root / "turns.jsonl").exists()


def test_store_isolates_project_ids_and_ignores_legacy_global_store(tmp_path: Path, monkeypatch) -> None:
    first = build_project(tmp_path, monkeypatch, "first-team")
    second = build_project(tmp_path, monkeypatch, "second-team")
    legacy = tmp_path / "rind_home" / "organization"
    legacy.mkdir(parents=True)
    (legacy / "messages.jsonl").write_text('{"legacy": true}\n', encoding="utf-8")

    first_store = JsonTeamStateStore(first)
    first_store.append_message(
        Message(id="msg_1", thread_id="thread_1", sender_id="user", recipient_id="main-agent", body="first")
    )
    second_store = JsonTeamStateStore(second)

    assert first_store.root != second_store.root
    assert second_store.list_messages() == []
    assert not (second_store.root / "messages.jsonl").exists()


def test_store_rejects_artifacts_outside_shared_root(tmp_path: Path, monkeypatch) -> None:
    project = build_project(tmp_path, monkeypatch)
    store = JsonTeamStateStore(project)
    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="user",
        recipient_id="main-agent",
        body="bad path",
        artifact_refs=(ArtifactRef(value="../escape/report.md"),),
    )

    with pytest.raises(ValueError, match="shared root"):
        store.append_message(message)
