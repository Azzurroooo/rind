import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import Agent, AgentConfig, InMemoryOrganizationStore, OrganizationCoordinator
from agent.domain.events import AssistantDeltaEvent, TurnCompletedEvent


class FakeRuntime:
    def __init__(self) -> None:
        self.query = ""
        self.transient_system_messages = None

    async def run_turn(self, query=None, transient_system_messages=None, cancellation_token=None):
        self.query = query or ""
        self.transient_system_messages = transient_system_messages
        yield AssistantDeltaEvent(text="worker result")
        yield TurnCompletedEvent(duration_ms=1)


class FakeContainer:
    def __init__(self, runtime: FakeRuntime) -> None:
        self.runtime = runtime


def seed_store() -> InMemoryOrganizationStore:
    store = InMemoryOrganizationStore()
    store.save_agent_config(AgentConfig(id="main_config", display_name="Main", system_prompt="Lead."))
    store.save_agent_config(
        AgentConfig(
            id="factor_config",
            display_name="Factor",
            system_prompt="Research factors.",
            enabled_tools=("read_file",),
            question_policy="route_to_supervisor",
            sop="Write concise findings.",
        )
    )
    store.save_agent(
        Agent(id="main", config_id="main_config", display_name="Main", session_id="main_session", workspace_root="main")
    )
    store.save_agent(
        Agent(
            id="factor",
            config_id="factor_config",
            display_name="Factor",
            session_id="factor_session",
            workspace_root="factor",
            supervisor_id="main",
        )
    )
    return store


@pytest.mark.asyncio
async def test_coordinator_builds_real_runtime_with_worker_tool_visibility_and_message_projection() -> None:
    store = seed_store()
    calls = []
    runtime = FakeRuntime()

    def build_container(**kwargs):
        calls.append(kwargs)
        return FakeContainer(runtime)

    coordinator = OrganizationCoordinator(store, container_builder=build_container, session_dir="sessions")
    message = await coordinator.send_message(sender_id="main", recipient_id="factor", body="research value factor")

    assert await coordinator.dispatch_pending(max_messages=1) == 1
    assert calls == [
        {
            "session_id": "factor_session",
            "session_dir": "sessions",
            "enabled_tools": ("read_file",),
            "enable_user_question": False,
        }
    ]
    assert f"message_id: {message.id}" in runtime.query
    assert "body:" in runtime.query
    assert "research value factor" in runtime.query
    assert runtime.transient_system_messages[0]["role"] == "system"
    assert "Do not ask the user directly" in runtime.transient_system_messages[0]["content"]

    reply = [item for item in store.list_messages() if item.reply_to == message.id][0]
    assert reply.sender_id == "factor"
    assert reply.recipient_id == "main"
    assert reply.body == "worker result"
