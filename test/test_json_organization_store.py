import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import Agent, AgentConfig, ArtifactRef, Delivery, Message
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.persistence.json_organization_store import JsonOrganizationStore


def build_store(tmp_path: Path) -> JsonOrganizationStore:
    store = JsonOrganizationStore(tmp_path / "organization", workspace_root=tmp_path / "workspaces")
    store.save_agent_config(
        AgentConfig(
            id="factor_config",
            display_name="Factor Agent",
            system_prompt="Research factors.",
        )
    )
    store.save_agent(
        Agent(
            id="factor",
            config_id="factor_config",
            display_name="Factor Agent",
            session_id="factor_session",
            workspace_root="factor",
        )
    )
    return store


def test_json_store_recovers_snapshots_and_pending_messages(tmp_path: Path) -> None:
    store = build_store(tmp_path)
    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="main",
        recipient_id="factor",
        body="research",
        artifact_refs=(ArtifactRef(kind="path", value="factor/report.md"),),
    )
    store.append_message(message)
    store.append_delivery(Delivery(message_id=message.id, recipient_id="factor"))

    restored = JsonOrganizationStore(tmp_path / "organization", workspace_root=tmp_path / "workspaces")

    assert restored.require_config("factor_config").display_name == "Factor Agent"
    assert restored.require_agent("factor").workspace_root == str((tmp_path / "workspaces" / "factor").resolve())
    assert restored.get_message("msg_1").body == "research"
    assert restored.get_delivery("msg_1", "factor").status == "pending"


def test_json_store_claim_and_projection_are_recovered_idempotently(tmp_path: Path) -> None:
    store = build_store(tmp_path)
    message = Message(id="msg_1", thread_id="thread_1", sender_id="main", recipient_id="factor", body="research")
    store.append_message(message)
    store.append_delivery(Delivery(message_id=message.id, recipient_id="factor"))

    claimed = store.claim_delivery("msg_1", "factor")
    assert claimed.status == "claimed"
    assert claimed.attempts == 1
    assert store.record_session_projection("factor", "msg_1") is True
    assert store.record_session_projection("factor", "msg_1") is False
    store.mark_delivery_processed("msg_1", "factor")

    restored = JsonOrganizationStore(tmp_path / "organization", workspace_root=tmp_path / "workspaces")

    assert restored.claim_delivery("msg_1", "factor") is None
    assert restored.get_delivery("msg_1", "factor").status == "processed"
    assert restored.has_session_projection("factor", "msg_1") is True


def test_json_store_rejects_workspace_escape(tmp_path: Path) -> None:
    store = JsonOrganizationStore(tmp_path / "organization", workspace_root=tmp_path / "workspaces")
    store.save_agent_config(AgentConfig(id="config", display_name="Agent", system_prompt="Work."))

    with pytest.raises(ValueError, match="workspace_root escapes"):
        store.save_agent(
            Agent(
                id="agent",
                config_id="config",
                display_name="Agent",
                session_id="session",
                workspace_root="../escape",
            )
        )


def test_json_store_rejects_artifact_path_escape(tmp_path: Path) -> None:
    store = build_store(tmp_path)
    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="main",
        recipient_id="factor",
        body="bad path",
        artifact_refs=(ArtifactRef(kind="path", value="../escape/report.md"),),
    )

    with pytest.raises(ValueError, match="artifact path escapes"):
        store.append_message(message)


def test_jsonl_session_store_exposes_lazy_default_organization_store(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), model="test-model")

    store = session.organization_store

    assert isinstance(store, JsonOrganizationStore)
    assert store.root == (tmp_path / "rind_home" / "organization").resolve()
    assert session.organization_store is store
