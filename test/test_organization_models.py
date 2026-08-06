import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import Agent, AgentConfig, ArtifactRef, Delivery, Message, TurnRecord


def test_organization_models_validate_minimal_fields() -> None:
    config = AgentConfig(
        id="factor_config",
        display_name="Factor Agent",
        system_prompt="Research factors.",
        enabled_tools=("read_file",),
        question_policy="route_to_supervisor",
    )
    agent = Agent(
        id="factor",
        config_id=config.id,
        display_name="Factor Agent",
        session_id="factor_session",
        workspace_root="factor",
        supervisor_id="main",
    )
    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="main",
        recipient_id="factor",
        body="Run a factor scan.",
        artifact_refs=(ArtifactRef(kind="path", value="factor/report.md"),),
    )
    delivery = Delivery(message_id=message.id, recipient_id="factor")
    turn = TurnRecord(
        turn_id="turn_1",
        agent_id=agent.id,
        message_id=message.id,
        status="started",
        started_at="2026-08-05T00:00:00+00:00",
    )

    assert config.enabled_tools == ("read_file",)
    assert agent.status == "idle"
    assert message.artifact_refs[0].kind == "path"
    assert delivery.status == "pending"
    assert turn.status == "started"


@pytest.mark.parametrize(
    "factory, message",
    [
        (lambda: AgentConfig(id="", display_name="x", system_prompt="x"), "config id"),
        (lambda: AgentConfig(id="c", display_name="x", system_prompt="x", question_policy="ask"), "question_policy"),
        (lambda: Agent(id="a", config_id="c", display_name="A", session_id="s", workspace_root="w", status="blocked"), "status"),
        (lambda: ArtifactRef(kind="blob", value="x"), "artifact kind"),
        (lambda: Delivery(message_id="m", recipient_id="a", attempts=-1), "attempts"),
        (lambda: TurnRecord(turn_id="t", agent_id="a", message_id="m", status="waiting", started_at="now"), "turn status"),
    ],
)
def test_organization_models_reject_invalid_values(factory, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        factory()


def test_message_round_trips_artifact_refs() -> None:
    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="main",
        recipient_id="factor",
        body="See artifact.",
        artifact_refs=(ArtifactRef(kind="hash", value="abc123"),),
    )

    restored = Message.from_dict(message.to_dict())

    assert restored == message
    assert restored.artifact_refs == (ArtifactRef(kind="hash", value="abc123"),)
