import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import AgentRuntimeState, ArtifactRef, Delivery, Message, OrganizationEvent


def test_dynamic_organization_models_round_trip() -> None:
    state = AgentRuntimeState(agent_id="factor", status="paused")
    message = Message(
        id="msg_1",
        thread_id="thread_1",
        sender_id="main",
        recipient_id="factor",
        body="Run a factor scan.",
        artifact_refs=(ArtifactRef(value="reports/factor.md"),),
    )
    delivery = Delivery(message_id=message.id, recipient_id="factor")
    event = OrganizationEvent(type="message_queued", agent_id="factor", message_id=message.id)

    assert AgentRuntimeState.from_dict(state.to_dict()) == state
    assert Message.from_dict(message.to_dict()) == message
    assert Delivery.from_dict(delivery.to_dict()) == delivery
    assert OrganizationEvent.from_dict(event.to_dict()) == event


@pytest.mark.parametrize(
    "factory, message",
    [
        (lambda: AgentRuntimeState(agent_id="a", status="working"), "runtime status"),
        (lambda: ArtifactRef(value="x", kind="hash"), "artifact kind"),
        (lambda: Delivery(message_id="m", recipient_id="a", status="processed"), "delivery status"),
        (lambda: Message(id="m", thread_id="t", sender_id="a", recipient_id="b", body=""), "body"),
    ],
)
def test_dynamic_organization_models_reject_invalid_values(factory, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        factory()
