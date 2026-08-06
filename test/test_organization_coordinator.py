import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.organization import Agent, AgentConfig, InMemoryOrganizationStore, OrganizationCoordinator


def seed_store() -> InMemoryOrganizationStore:
    store = InMemoryOrganizationStore()
    for config_id, name in (("main_config", "Main Agent"), ("factor_config", "Factor Agent")):
        store.save_agent_config(
            AgentConfig(
                id=config_id,
                display_name=name,
                system_prompt=f"You are {name}.",
                enabled_tools=("read_file",),
            )
        )
    store.save_agent(
        Agent(
            id="main",
            config_id="main_config",
            display_name="Main Agent",
            session_id="main_session",
            workspace_root="main",
        )
    )
    store.save_agent(
        Agent(
            id="factor",
            config_id="factor_config",
            display_name="Factor Agent",
            session_id="factor_session",
            workspace_root="factor",
            supervisor_id="main",
        )
    )
    return store


@pytest.mark.asyncio
async def test_memory_coordinator_runs_a_to_b_to_a_without_blocking_sender() -> None:
    store = seed_store()
    received_by_main: list[str] = []

    async def factor_worker(context):
        assert context.message.sender_id == "main"
        await context.reply("factor report ready", artifact_refs=({"kind": "path", "value": "factor/report.md"},))

    async def main_worker(context):
        received_by_main.append(context.message.body)

    coordinator = OrganizationCoordinator(
        store,
        worker_handlers={"factor": factor_worker, "main": main_worker},
        max_reply_depth=4,
    )

    message = await coordinator.send_message(sender_id="main", recipient_id="factor", body="research value factor")

    assert store.get_delivery(message.id, "factor").status == "pending"
    assert store.list_turns() == []
    assert received_by_main == []

    assert await coordinator.dispatch_next_pending() is True
    assert store.get_delivery(message.id, "factor").status == "processed"
    assert received_by_main == []
    reply = [item for item in store.list_messages() if item.reply_to == message.id][0]
    assert reply.recipient_id == "main"
    assert reply.artifact_refs[0].value == "factor/report.md"

    assert await coordinator.dispatch_next_pending() is True
    assert received_by_main == ["factor report ready"]


@pytest.mark.asyncio
async def test_memory_coordinator_does_not_process_duplicate_delivery_twice() -> None:
    store = seed_store()
    calls = 0

    async def factor_worker(context):
        nonlocal calls
        calls += 1

    coordinator = OrganizationCoordinator(store, worker_handlers={"factor": factor_worker})
    message = await coordinator.send_message(sender_id="main", recipient_id="factor", body="once")

    store.append_delivery(store.get_delivery(message.id, "factor"))
    assert await coordinator.dispatch_pending() == 1

    assert calls == 1
    assert store.claim_delivery(message.id, "factor") is None
    assert store.get_delivery(message.id, "factor").status == "processed"


@pytest.mark.asyncio
async def test_memory_coordinator_marks_worker_exception_failed_and_agent_idle() -> None:
    store = seed_store()

    async def failing_worker(context):
        raise RuntimeError("boom")

    coordinator = OrganizationCoordinator(store, worker_handlers={"factor": failing_worker})
    message = await coordinator.send_message(sender_id="main", recipient_id="factor", body="fail")

    assert await coordinator.dispatch_pending() == 1
    assert store.get_delivery(message.id, "factor").status == "failed"
    assert store.require_agent("factor").status == "idle"
    assert store.list_turns(message_id=message.id)[-1].status == "failed"
    assert any(event.type == "message_failed" for event in store.list_events())


@pytest.mark.asyncio
async def test_memory_coordinator_skips_paused_agent() -> None:
    store = seed_store()
    store.update_agent_status("factor", "paused")
    coordinator = OrganizationCoordinator(store, worker_handlers={"factor": lambda context: None})
    message = await coordinator.send_message(sender_id="main", recipient_id="factor", body="wait")

    assert await coordinator.dispatch_pending() == 0
    assert store.get_delivery(message.id, "factor").status == "pending"
    assert store.list_turns() == []


@pytest.mark.asyncio
async def test_memory_coordinator_honors_max_reply_depth() -> None:
    store = seed_store()

    async def ping_pong(context):
        await context.reply(f"reply from {context.agent.id}")

    coordinator = OrganizationCoordinator(
        store,
        worker_handlers={"factor": ping_pong, "main": ping_pong},
        max_reply_depth=2,
    )
    await coordinator.send_message(sender_id="main", recipient_id="factor", body="start")

    assert await coordinator.dispatch_pending() == 2
    assert len(store.list_deliveries(status="pending")) == 1
    assert len([turn for turn in store.list_turns() if turn.status == "completed"]) == 2
