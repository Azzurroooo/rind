import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import OrganizationCoordinator
from agent.infrastructure.persistence.json_team_state_store import JsonTeamStateStore
from agent.infrastructure.team import initialize_team_project


def build_coordinator(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    project_root = tmp_path / "project"
    project_root.mkdir()
    project = initialize_team_project(project_root, project_id="team-project")
    store = JsonTeamStateStore(project)
    return OrganizationCoordinator(store, agent_ids=project.agents), store


@pytest.mark.asyncio
async def test_coordinator_queues_message_without_dispatching(tmp_path: Path, monkeypatch) -> None:
    coordinator, store = build_coordinator(tmp_path, monkeypatch)

    message = await coordinator.send_message(sender_id="user", recipient_id="main-agent", body="research")

    assert store.get_message(message.id) == message
    assert store.get_delivery(message.id, "main-agent").status == "pending"
    assert [event.type for event in store.list_events()] == ["message_queued"]


@pytest.mark.asyncio
async def test_coordinator_requires_manifest_members(tmp_path: Path, monkeypatch) -> None:
    coordinator, _ = build_coordinator(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="Team member"):
        await coordinator.send_message(sender_id="user", recipient_id="unknown", body="research")
    with pytest.raises(ValueError, match="Team member"):
        await coordinator.send_message(sender_id="unknown", recipient_id="main-agent", body="research")


def test_coordinator_persists_pause_and_resume(tmp_path: Path, monkeypatch) -> None:
    coordinator, store = build_coordinator(tmp_path, monkeypatch)

    coordinator.set_agent_status("main-agent", "paused")
    coordinator.set_agent_status("main-agent", "idle")

    assert store.get_agent_state("main-agent").status == "idle"
    assert [event.type for event in store.list_events()] == ["agent_paused", "agent_idle"]
